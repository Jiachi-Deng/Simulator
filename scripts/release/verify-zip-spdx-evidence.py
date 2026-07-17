#!/usr/bin/env python3
"""Derive SPDX file evidence directly from the original bounded app ZIP."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import sys
import zipfile


APP_ROOT = "Simulator.app/"
MAXIMUM_EVIDENCE_BYTES = 256 * 1024 * 1024
MAXIMUM_ARCHIVE_BYTES = 1280 * 1024 * 1024


def require_regular(path: str, label: str, maximum_bytes: int) -> os.stat_result:
    metadata = os.lstat(path)
    if (not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_nlink != 1 or metadata.st_size <= 0
            or metadata.st_size > maximum_bytes):
        raise ValueError(f"{label} must be one bounded real regular file")
    return metadata


def preflight(archive: str) -> None:
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "preflight-macos-release-artifact.py")
    subprocess.run(
        [sys.executable, script, "zip", archive],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )


def derive(archive: str) -> tuple[str, str, int]:
    require_regular(archive, "Original app ZIP", MAXIMUM_ARCHIVE_BYTES)
    preflight(archive)

    files: list[tuple[str, str, str]] = []
    saw_root = False
    with zipfile.ZipFile(archive) as source:
        for info in source.infolist():
            name = info.filename
            if name == APP_ROOT:
                if not info.is_dir() or saw_root:
                    raise ValueError("ZIP Simulator.app root entry is invalid")
                saw_root = True
                continue
            if not name.startswith(APP_ROOT):
                raise ValueError("ZIP contains payload outside Simulator.app")
            relative = name[len(APP_ROOT):]
            mode = info.external_attr >> 16
            if info.is_dir() or stat.S_ISLNK(mode):
                continue
            kind = stat.S_IFMT(mode)
            if kind not in {0, stat.S_IFREG}:
                raise ValueError("ZIP SPDX derivation encountered a special file")
            sha1 = hashlib.sha1()
            sha256 = hashlib.sha256()
            expanded = 0
            with source.open(info) as reader:
                while chunk := reader.read(1024 * 1024):
                    expanded += len(chunk)
                    if expanded > info.file_size:
                        raise ValueError("ZIP member expanded beyond its declared size")
                    sha1.update(chunk)
                    sha256.update(chunk)
            if expanded != info.file_size:
                raise ValueError("ZIP member expanded size changed during SPDX derivation")
            files.append((relative, sha1.hexdigest(), sha256.hexdigest()))

    if not saw_root or not files:
        raise ValueError("ZIP must contain one explicit non-empty Simulator.app tree")
    files.sort(key=lambda entry: entry[0])
    checksums = "".join(f"{digest}  {path}\n" for path, _sha1, digest in files)
    code = hashlib.sha1("".join(sorted(sha1 for _path, sha1, _sha256 in files)).encode("ascii")).hexdigest()
    return checksums, code, len(files)


def verify(archive: str, checksums_path: str, verification_code_path: str) -> dict:
    require_regular(checksums_path, "packaged-files.sha256", MAXIMUM_EVIDENCE_BYTES)
    require_regular(verification_code_path, "package-verification-code.txt", MAXIMUM_EVIDENCE_BYTES)
    expected_checksums, expected_code, count = derive(archive)
    with open(checksums_path, "r", encoding="utf-8", newline="") as source:
        if source.read() != expected_checksums:
            raise ValueError("packaged-files.sha256 does not derive from the original app ZIP")
    with open(verification_code_path, "r", encoding="ascii", newline="") as source:
        if source.read() != f"{expected_code}\n":
            raise ValueError("SPDX package verification code does not derive from the original app ZIP")
    return {"ok": True, "mode": "verify", "regularFiles": count, "packageVerificationCode": expected_code}


def write_derived(archive: str, destination: str) -> dict:
    destination = os.path.abspath(destination)
    metadata = os.lstat(destination)
    if (not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700
            or os.path.realpath(destination) != destination or os.listdir(destination)):
        raise ValueError("Derived SPDX destination must be an empty owner-only canonical directory")
    checksums, code, count = derive(archive)
    for name, content in [
        ("packaged-files.sha256", checksums),
        ("package-verification-code.txt", f"{code}\n"),
    ]:
        path = os.path.join(destination, name)
        with open(path, "x", encoding="ascii", newline="") as output:
            output.write(content)
        os.chmod(path, 0o600)
    return {"ok": True, "mode": "derive", "regularFiles": count, "packageVerificationCode": code}


def main() -> int:
    if len(sys.argv) == 4 and sys.argv[1] == "derive":
        result = write_derived(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 5 and sys.argv[1] == "verify":
        result = verify(*sys.argv[2:])
    else:
        raise ValueError("Usage: verify-zip-spdx-evidence.py derive ORIGINAL_ZIP EMPTY_OUTPUT_DIR | verify ORIGINAL_ZIP PACKAGED_CHECKSUMS VERIFICATION_CODE")
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
