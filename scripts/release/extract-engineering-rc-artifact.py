#!/usr/bin/env python3
import json
import os
import stat
import sys
import zipfile

from zip_safety import preflight_zip_central_directory


BASE_FILES = {
    "RELEASE_NOTES.md",
    "SHA256SUMS",
    "Simulator-arm64.dmg",
    "Simulator-arm64.zip",
    "app-inventory.jsonl",
    "bundle-metadata.json",
    "dmg-app-inventory.raw.jsonl",
    "dmg-signatures.json",
    "package-verification-code.txt",
    "packaged-files.sha256",
    "rc-validation.json",
    "sbom.spdx.json",
    "transport-normalization-policy.json",
    "verification-input.json",
    "zip-app-inventory.raw.jsonl",
    "zip-signatures.json",
}
ATTESTATION_FILES = {
    "attestations/provenance.sigstore.json",
    "attestations/sbom.sigstore.json",
}
ZIP_SBOM_FILES = {
    "package-verification-code.txt",
    "packaged-files.sha256",
    "sbom.spdx.json",
    "zip-sbom-lineage.json",
}
SIGNED_HOST_PRE_FILES = {
    "Simulator-arm64.dmg",
    "Simulator-arm64.zip",
    "app-notarization.json",
    "dmg-notarization.json",
    "dmg-signatures.json",
    "h3-post-install-v1.schema.json",
    "payload-equivalence.json",
    "signed-host-manifest.json",
    "signed-host-provenance.json",
    "zip-signatures.json",
}
SIGNED_HOST_FINAL_FILES = SIGNED_HOST_PRE_FILES | {
    "SHA256SUMS",
    "attestations/provenance.sigstore.json",
}
MAXIMUM_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAXIMUM_SIGNED_HOST_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024
MAXIMUM_TOTAL_BYTES = 3 * 1024 * 1024 * 1024
MAXIMUM_CENTRAL_DIRECTORY_BYTES = 1024 * 1024


def maximum_bytes(path: str) -> int:
    if path in {"Simulator-arm64.dmg", "Simulator-arm64.zip"}:
        return 1280 * 1024 * 1024
    if path in {"app-inventory.jsonl", "dmg-app-inventory.raw.jsonl", "zip-app-inventory.raw.jsonl"}:
        return 256 * 1024 * 1024
    if path == "sbom.spdx.json":
        return 128 * 1024 * 1024
    if path == "SHA256SUMS":
        return 64 * 1024
    return 32 * 1024 * 1024


def require_real_regular_file(path: str, label: str) -> os.stat_result:
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError(f"{label} must be one real regular file")
    return metadata


def require_empty_owner_directory(path: str) -> None:
    metadata = os.lstat(path)
    if (not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
            or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700
            or os.path.realpath(path) != os.path.abspath(path) or os.listdir(path)):
        raise ValueError("Extraction destination must be an empty owner-only canonical directory")


def extract(phase: str, archive: str, destination: str) -> dict:
    if phase not in {"input", "pre", "final", "zip-sbom", "signed-host-pre", "signed-host-final"}:
        raise ValueError("Phase must be input, pre, final, zip-sbom, signed-host-pre, or signed-host-final")
    archive = os.path.abspath(archive)
    destination = os.path.abspath(destination)
    if phase == "input":
        expected_files = {"Simulator-arm64.dmg", "Simulator-arm64.zip"}
    elif phase == "zip-sbom":
        expected_files = ZIP_SBOM_FILES
    elif phase == "signed-host-pre":
        expected_files = SIGNED_HOST_PRE_FILES
    elif phase == "signed-host-final":
        expected_files = SIGNED_HOST_FINAL_FILES
    else:
        expected_files = BASE_FILES | (ATTESTATION_FILES if phase == "final" else set())
    # upload-artifact archives regular files only; nested parents are materialized safely here.
    expected_directories = set()
    archive_metadata = require_real_regular_file(archive, "Artifact archive")
    archive_limit = MAXIMUM_SIGNED_HOST_ARCHIVE_BYTES if phase in {"signed-host-pre", "signed-host-final"} else MAXIMUM_ARCHIVE_BYTES
    if archive_metadata.st_size <= 0 or archive_metadata.st_size > archive_limit:
        raise ValueError("Artifact archive exceeds its size limit")
    preflight_zip_central_directory(
        archive,
        maximum_archive_bytes=archive_limit,
        maximum_entries=len(expected_files) + len(expected_directories),
        maximum_directory_bytes=MAXIMUM_CENTRAL_DIRECTORY_BYTES,
        expected_entries=len(expected_files) + len(expected_directories),
    )
    require_empty_owner_directory(destination)

    seen = set()
    extracted = set()
    directories = set()
    total = 0

    with zipfile.ZipFile(archive) as source:
        for info in source.infolist():
            name = info.filename
            parts = name.rstrip("/").split("/")
            if (not name or "\\" in name or "\x00" in name or name.startswith("/")
                    or any(part in {"", ".", ".."} for part in parts) or name in seen):
                raise ValueError("Artifact contains an unsafe or duplicate path")
            seen.add(name)
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if stat.S_ISLNK(mode) or kind not in {0, stat.S_IFREG, stat.S_IFDIR}:
                raise ValueError("Artifact contains a non-regular member")
            if info.flag_bits & 1:
                raise ValueError("Artifact contains an encrypted member")
            if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                raise ValueError("Artifact uses an unsupported compression method")
            if info.is_dir():
                if name not in expected_directories:
                    raise ValueError("Artifact contains an unexpected directory")
                directory = os.path.join(destination, *parts)
                if os.path.lexists(directory):
                    metadata = os.lstat(directory)
                    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                        raise ValueError("Artifact directory conflicts with a non-directory member")
                else:
                    os.mkdir(directory, 0o700)
                os.chmod(directory, 0o700)
                directories.add(name)
                continue
            if name not in expected_files:
                raise ValueError("Artifact contains an unexpected file")
            limit = maximum_bytes(name)
            if info.file_size <= 0 or info.file_size > limit:
                raise ValueError("Artifact member exceeds its size limit")
            total += info.file_size
            if total > MAXIMUM_TOTAL_BYTES:
                raise ValueError("Artifact exceeds its total expansion limit")

            destination_path = os.path.join(destination, *parts)
            parent = os.path.dirname(destination_path)
            if parent != destination:
                if os.path.lexists(parent):
                    parent_metadata = os.lstat(parent)
                    if not stat.S_ISDIR(parent_metadata.st_mode) or stat.S_ISLNK(parent_metadata.st_mode):
                        raise ValueError("Artifact parent is not a real directory")
                else:
                    os.mkdir(parent, 0o700)
                os.chmod(parent, 0o700)
            written = 0
            with source.open(info) as reader, open(destination_path, "xb") as writer:
                while chunk := reader.read(1024 * 1024):
                    written += len(chunk)
                    if written > info.file_size or written > limit:
                        raise ValueError("Artifact member expanded beyond its declared limit")
                    writer.write(chunk)
            if written != info.file_size or os.path.getsize(destination_path) != info.file_size:
                raise ValueError("Artifact member changed during extraction")
            os.chmod(destination_path, 0o600)
            extracted_metadata = require_real_regular_file(destination_path, "Extracted artifact member")
            if extracted_metadata.st_uid != os.getuid() or stat.S_IMODE(extracted_metadata.st_mode) != 0o600:
                raise ValueError("Extracted artifact member is not owner-only")
            extracted.add(name)

    if extracted != expected_files or directories != expected_directories or seen != expected_files | expected_directories:
        raise ValueError("Artifact does not match the exact Engineering RC closure")
    return {
        "ok": True,
        "phase": phase,
        "files": len(extracted),
        "directories": len(directories),
        "expandedBytes": total,
    }


def main() -> int:
    if len(sys.argv) != 4:
        raise ValueError("Usage: extract-engineering-rc-artifact.py input|pre|final|zip-sbom|signed-host-pre|signed-host-final ARCHIVE EMPTY_DESTINATION")
    print(json.dumps(extract(sys.argv[1], sys.argv[2], sys.argv[3]), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
