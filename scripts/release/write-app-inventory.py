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


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
        entry["sha256"] = sha256_file(path)
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("inventory", type=Path)
    parser.add_argument("--spdx-files", required=True, type=Path, metavar="PATH")
    args = parser.parse_args()

    root = args.app.resolve()
    if not root.is_dir() or root.suffix != ".app":
        raise RuntimeError(f"Expected an app bundle directory: {args.app}")

    entries = walk(root)
    args.inventory.write_text(
        "".join(json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n" for entry in entries),
        encoding="utf-8",
    )
    write_spdx_checksums(entries, args.spdx_files)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as error:
        print(f"app inventory failed: {error}", file=sys.stderr)
        raise SystemExit(1)
