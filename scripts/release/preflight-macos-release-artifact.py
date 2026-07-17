#!/usr/bin/env python3
"""Bound macOS release containers before native parsing or recursive inspection."""

from __future__ import annotations

import json
import os
import posixpath
import stat
import sys
import unicodedata
import zipfile

from zip_safety import preflight_zip_central_directory


MAXIMUM_ARCHIVE_BYTES = 1280 * 1024 * 1024
MAXIMUM_ENTRIES = 100_000
MAXIMUM_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024
MAXIMUM_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024
MAXIMUM_MEMBER_BYTES = 2 * 1024 * 1024 * 1024
MAXIMUM_PATH_BYTES = 4096


def require_regular_file(path: str, label: str) -> os.stat_result:
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError(f"{label} must be one real regular file")
    if metadata.st_size <= 0 or metadata.st_size > MAXIMUM_ARCHIVE_BYTES:
        raise ValueError(f"{label} exceeds its size limit")
    return metadata


def safe_relative_path(path: str) -> bool:
    parts = path.rstrip("/").split("/")
    return bool(path) and not path.startswith("/") and "\\" not in path and "\x00" not in path \
        and len(path.encode("utf-8")) <= MAXIMUM_PATH_BYTES \
        and all(part not in {"", ".", ".."} for part in parts)


def filesystem_key(path: str) -> str:
    """Model the case-insensitive, normalization-aware default macOS filesystem."""
    return "/".join(unicodedata.normalize("NFD", part).casefold() for part in path.split("/"))


def preflight_dmg(path: str) -> dict:
    metadata = require_regular_file(path, "DMG")
    return {"ok": True, "kind": "dmg", "archiveBytes": metadata.st_size}


def preflight_zip(path: str) -> dict:
    require_regular_file(path, "ZIP")
    central = preflight_zip_central_directory(
        path,
        maximum_archive_bytes=MAXIMUM_ARCHIVE_BYTES,
        maximum_entries=MAXIMUM_ENTRIES,
        maximum_directory_bytes=MAXIMUM_CENTRAL_DIRECTORY_BYTES,
    )
    seen = set()
    filesystem_paths = set()
    non_directories = set()
    total = 0
    with zipfile.ZipFile(path) as source:
        infos = source.infolist()
        if len(infos) != central["entries"]:
            raise ValueError("ZIP entry count changed after central-directory preflight")
        for info in infos:
            name = info.filename
            logical_name = name.rstrip("/")
            key = filesystem_key(logical_name)
            if not safe_relative_path(name) or name in seen or key in filesystem_paths:
                raise ValueError("ZIP contains an unsafe or duplicate path")
            seen.add(name)
            filesystem_paths.add(key)
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if stat.S_ISLNK(mode):
                if info.file_size <= 0 or info.file_size > MAXIMUM_PATH_BYTES:
                    raise ValueError("ZIP symlink target exceeds its size limit")
                non_directories.add(key)
            elif info.is_dir():
                if kind not in {0, stat.S_IFDIR}:
                    raise ValueError("ZIP directory has a non-directory mode")
            elif kind not in {0, stat.S_IFREG}:
                raise ValueError("ZIP contains a special file")
            else:
                non_directories.add(key)
            if info.flag_bits & 1:
                raise ValueError("ZIP contains an encrypted member")
            if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                raise ValueError("ZIP uses an unsupported compression method")
            if info.file_size < 0 or info.file_size > MAXIMUM_MEMBER_BYTES:
                raise ValueError("ZIP member exceeds its expanded-size limit")
            total += info.file_size
            if total > MAXIMUM_EXPANDED_BYTES:
                raise ValueError("ZIP exceeds its total expanded-size limit")
            if not info.is_dir():
                expanded = 0
                symlink_payload = bytearray() if stat.S_ISLNK(mode) else None
                with source.open(info) as reader:
                    while chunk := reader.read(1024 * 1024):
                        expanded += len(chunk)
                        if expanded > info.file_size or expanded > MAXIMUM_MEMBER_BYTES:
                            raise ValueError("ZIP member expands beyond its declared limit")
                        if symlink_payload is not None:
                            symlink_payload.extend(chunk)
                if expanded != info.file_size:
                    raise ValueError("ZIP member expanded size does not match its declaration")
                if symlink_payload is not None:
                    try:
                        target = bytes(symlink_payload).decode("utf-8")
                    except UnicodeDecodeError as error:
                        raise ValueError("ZIP symlink target must be UTF-8") from error
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(logical_name), target))
                    if (not target or target.startswith("/") or "\\" in target or "\x00" in target
                            or resolved in {"", ".", ".."} or resolved.startswith("../")
                            or posixpath.isabs(resolved)):
                        raise ValueError("ZIP symlink target escapes its archive root")

        for key in filesystem_paths:
            parts = key.split("/")
            for length in range(1, len(parts)):
                if "/".join(parts[:length]) in non_directories:
                    raise ValueError("ZIP member traverses a non-directory archive entry")
    return {
        "ok": True,
        "kind": "zip",
        **central,
        "expandedBytes": total,
    }


def preflight_tree(root: str, *, allow_external_symlinks: bool = False, kind: str = "tree") -> dict:
    root = os.path.abspath(root)
    metadata = os.lstat(root)
    if (not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or os.path.realpath(root) != root):
        raise ValueError("App tree root must be one real canonical directory")
    entries = 0
    total = 0
    stack = [root]
    while stack:
        directory = stack.pop()
        with os.scandir(directory) as children:
            for entry in children:
                entries += 1
                if entries > MAXIMUM_ENTRIES:
                    raise ValueError("App tree entry count exceeds its limit")
                path = entry.path
                item = os.lstat(path)
                relative = os.path.relpath(path, root).replace(os.sep, "/")
                if not safe_relative_path(relative):
                    raise ValueError("App tree contains an unsafe path")
                if stat.S_ISLNK(item.st_mode):
                    target = os.readlink(path)
                    resolved = None if allow_external_symlinks else os.path.realpath(path)
                    if (not target or "\x00" in target or len(target.encode("utf-8")) > MAXIMUM_PATH_BYTES
                            or (resolved is not None and os.path.commonpath([root, resolved]) != root)):
                        raise ValueError("App tree contains an unsafe symlink")
                elif stat.S_ISDIR(item.st_mode):
                    stack.append(path)
                elif stat.S_ISREG(item.st_mode):
                    if item.st_nlink != 1:
                        raise ValueError("App tree contains a hard-linked regular file")
                    if item.st_size > MAXIMUM_MEMBER_BYTES:
                        raise ValueError("App tree file exceeds its size limit")
                    total += item.st_size
                    if total > MAXIMUM_EXPANDED_BYTES:
                        raise ValueError("App tree exceeds its total byte limit")
                else:
                    raise ValueError("App tree contains a special file")
    return {"ok": True, "kind": kind, "entries": entries, "regularFileBytes": total}


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {"dmg", "zip", "tree", "container-tree"}:
        raise ValueError("Usage: preflight-macos-release-artifact.py dmg|zip|tree|container-tree PATH")
    mode, path = sys.argv[1:]
    if mode == "dmg":
        result = preflight_dmg(path)
    elif mode == "zip":
        result = preflight_zip(path)
    elif mode == "container-tree":
        result = preflight_tree(path, allow_external_symlinks=True, kind="container-tree")
    else:
        result = preflight_tree(path)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
