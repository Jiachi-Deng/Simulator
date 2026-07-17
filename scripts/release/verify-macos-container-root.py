#!/usr/bin/env python3
"""Verify exact Finder-facing DMG and ZIP root closures before attestation."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import sys


DMG_ENTRIES = {".DS_Store", ".VolumeIcon.icns", ".background.tiff", "Applications", "Simulator.app"}
MAXIMUM_PRESENTATION_BYTES = 32 * 1024 * 1024


def regular(path: str, label: str) -> os.stat_result:
    metadata = os.lstat(path)
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_nlink != 1 or metadata.st_size <= 0
            or metadata.st_size > MAXIMUM_PRESENTATION_BYTES or metadata.st_mode & 0o111):
        raise ValueError(f"{label} must be one bounded non-executable regular file")
    return metadata


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb", buffering=0) as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_root(path: str) -> str:
    root = os.path.abspath(path)
    metadata = os.lstat(root)
    if (not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or os.path.realpath(root) != root):
        raise ValueError("Container root must be one real canonical directory")
    return root


def app(root: str) -> str:
    path = os.path.join(root, "Simulator.app")
    metadata = os.lstat(path)
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise ValueError("Simulator.app must be one real directory")
    return path


def verify_dmg(root: str, expected_background: str, expected_icon: str) -> dict:
    root = canonical_root(root)
    if set(os.listdir(root)) != DMG_ENTRIES:
        raise ValueError("DMG root does not match the exact Finder presentation closure")
    app(root)

    applications = os.path.join(root, "Applications")
    applications_metadata = os.lstat(applications)
    if not stat.S_ISLNK(applications_metadata.st_mode) or os.readlink(applications) != "/Applications":
        raise ValueError("DMG Applications entry must be the exact /Applications symlink")

    regular(os.path.join(root, ".DS_Store"), "DMG .DS_Store")
    for name, expected, label in [
        (".background.tiff", expected_background, "DMG background"),
        (".VolumeIcon.icns", expected_icon, "DMG volume icon"),
    ]:
        actual = os.path.join(root, name)
        regular(actual, label)
        regular(expected, f"Expected {label.lower()}")
        if sha256(actual) != sha256(expected):
            raise ValueError(f"{label} does not match exact source bytes")
    return {"ok": True, "kind": "dmg-root", "entries": sorted(DMG_ENTRIES)}


def verify_zip(root: str) -> dict:
    root = canonical_root(root)
    if os.listdir(root) != ["Simulator.app"]:
        raise ValueError("ZIP root must contain exactly Simulator.app")
    app(root)
    return {"ok": True, "kind": "zip-root", "entries": ["Simulator.app"]}


def main() -> int:
    if len(sys.argv) == 5 and sys.argv[1] == "dmg":
        result = verify_dmg(sys.argv[2], sys.argv[3], sys.argv[4])
    elif len(sys.argv) == 3 and sys.argv[1] == "zip":
        result = verify_zip(sys.argv[2])
    else:
        raise ValueError("Usage: verify-macos-container-root.py dmg ROOT BACKGROUND ICON | zip ROOT")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
