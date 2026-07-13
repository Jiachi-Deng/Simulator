#!/usr/bin/env python3
"""Write a deterministic macOS app-bundle inventory and SPDX file checksums."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any


def file_digests(path: Path) -> tuple[str, str]:
    sha1 = hashlib.sha1()
    sha256 = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            sha1.update(chunk)
            sha256.update(chunk)
    return sha1.hexdigest(), sha256.hexdigest()


def xattrs(path: Path) -> list[dict[str, str]]:
    if not hasattr(os, "listxattr"):
        return macos_xattrs(path)
    try:
        names = os.listxattr(path, follow_symlinks=False)
    except OSError as error:
        raise RuntimeError(f"Could not list extended attributes for {path}: {error}") from error

    values: list[dict[str, str]] = []
    for name in sorted(names):
        try:
            value = os.getxattr(path, name, follow_symlinks=False)
        except OSError as error:
            raise RuntimeError(f"Could not read extended attribute {name!r} for {path}: {error}") from error
        values.append({"name": name, "sha256": hashlib.sha256(value).hexdigest()})
    return values


def macos_xattrs(path: Path) -> list[dict[str, str]]:
    """Use macOS's xattr utility when the system Python lacks xattr bindings."""
    try:
        names = subprocess.run(
            ["xattr", "-s", str(path)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        ).stdout.splitlines()
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError(f"Could not list extended attributes for {path}: {error}") from error

    values: list[dict[str, str]] = []
    for name in sorted(names):
        try:
            hex_value = subprocess.run(
                ["xattr", "-s", "-p", "-x", name, str(path)],
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            ).stdout
            value = bytes.fromhex(hex_value)
        except (OSError, ValueError, subprocess.CalledProcessError) as error:
            raise RuntimeError(f"Could not read extended attribute {name!r} for {path}: {error}") from error
        values.append({"name": name, "sha256": hashlib.sha256(value).hexdigest()})
    return values


def relative_path(root: Path, path: Path) -> str:
    value = path.relative_to(root).as_posix()
    return "." if value == "." else value


def inventory_entry(root: Path, path: Path) -> dict[str, Any]:
    metadata = path.lstat()
    mode = stat.S_IMODE(metadata.st_mode)
    entry: dict[str, Any] = {
        "flags": getattr(metadata, "st_flags", 0),
        "gid": metadata.st_gid,
        "mode": f"{mode:04o}",
        "path": relative_path(root, path),
        "uid": metadata.st_uid,
        "xattrs": xattrs(path),
    }

    if stat.S_ISDIR(metadata.st_mode):
        entry["type"] = "directory"
    elif stat.S_ISREG(metadata.st_mode):
        entry["sha1"], entry["sha256"] = file_digests(path)
        entry["type"] = "file"
    elif stat.S_ISLNK(metadata.st_mode):
        entry["target"] = os.readlink(path)
        entry["type"] = "symlink"
    else:
        raise RuntimeError(f"Unsupported app-bundle entry type: {path}")
    return entry


def walk(root: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    def visit(path: Path) -> None:
        entries.append(inventory_entry(root, path))
        if not path.is_dir() or path.is_symlink():
            return
        with os.scandir(path) as children:
            for child in sorted(children, key=lambda item: item.name):
                visit(Path(child.path))

    visit(root)
    return sorted(entries, key=lambda item: item["path"])


def write_spdx_checksums(entries: list[dict[str, Any]], output: Path) -> None:
    lines: list[str] = []
    for entry in entries:
        if entry["type"] != "file":
            continue
        path = entry["path"]
        if path == "." or "\n" in path or "\r" in path:
            raise RuntimeError(f"Unsupported artifact file path for SPDX checksum format: {path!r}")
        lines.append(f"{entry['sha256']}  {path}\n")
    output.write_text("".join(lines), encoding="utf-8")


def write_spdx_package_verification_code(entries: list[dict[str, Any]], output: Path) -> None:
    file_sha1s = sorted(entry["sha1"] for entry in entries if entry["type"] == "file")
    if not file_sha1s:
        raise RuntimeError("Cannot calculate an SPDX package verification code without regular files")
    code = hashlib.sha1("".join(file_sha1s).encode("ascii")).hexdigest()
    output.write_text(f"{code}\n", encoding="utf-8")


def app_root(path: Path) -> Path:
    root = path.absolute()
    try:
        metadata = root.lstat()
    except OSError as error:
        raise RuntimeError(f"Could not inspect app bundle root {path}: {error}") from error
    if stat.S_ISLNK(metadata.st_mode):
        raise RuntimeError(f"Symbolic links are not allowed for app bundle roots: {path}")
    if not stat.S_ISDIR(metadata.st_mode) or root.suffix != ".app":
        raise RuntimeError(f"Expected an app bundle directory: {path}")
    return root


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("inventory", type=Path)
    parser.add_argument("--spdx-files", required=True, type=Path, metavar="PATH")
    parser.add_argument("--spdx-package-verification-code", required=True, type=Path, metavar="PATH")
    args = parser.parse_args()

    root = app_root(args.app)
    entries = walk(root)
    args.inventory.write_text(
        "".join(json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n" for entry in entries),
        encoding="utf-8",
    )
    write_spdx_checksums(entries, args.spdx_files)
    write_spdx_package_verification_code(entries, args.spdx_package_verification_code)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"app inventory failed: {error}", file=sys.stderr)
        raise SystemExit(1)
