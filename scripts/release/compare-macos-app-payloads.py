#!/usr/bin/env python3
"""Prove signed and Engineering RC app payload equivalence without trusting codesign removal."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import struct
import sys
from pathlib import Path

MH_MAGIC_64 = 0xFEEDFACF
CPU_TYPE_ARM64 = 0x0100000C
LC_CODE_SIGNATURE = 0x1D
LC_SEGMENT_64 = 0x19
SIGNATURE_METADATA_SUFFIX = ("_CodeSignature", "CodeResources")


class EquivalenceError(Exception):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_macho(path: Path) -> tuple[str, int, int]:
    data = bytearray(path.read_bytes())
    if len(data) < 32:
        raise EquivalenceError(f"Mach-O is truncated: {path}")
    magic, cpu_type, _cpu_subtype, _file_type, ncmds, sizeofcmds, _flags, _reserved = struct.unpack_from("<8I", data)
    if magic != MH_MAGIC_64 or cpu_type != CPU_TYPE_ARM64:
        raise EquivalenceError(f"Mach-O must be thin arm64: {path}")
    commands_end = 32 + sizeofcmds
    if commands_end > len(data):
        raise EquivalenceError(f"Mach-O load commands exceed file: {path}")
    cursor = 32
    signature_commands: list[tuple[int, int, int]] = []
    linkedit_commands: list[tuple[int, int, int, int]] = []
    for _ in range(ncmds):
        if cursor + 8 > commands_end:
            raise EquivalenceError(f"Mach-O load command header is truncated: {path}")
        command, command_size = struct.unpack_from("<II", data, cursor)
        if command_size < 8 or cursor + command_size > commands_end:
            raise EquivalenceError(f"Mach-O load command size is invalid: {path}")
        if command == LC_CODE_SIGNATURE:
            if command_size != 16:
                raise EquivalenceError(f"LC_CODE_SIGNATURE has unexpected size: {path}")
            data_offset, data_size = struct.unpack_from("<II", data, cursor + 8)
            signature_commands.append((cursor, data_offset, data_size))
        elif command == LC_SEGMENT_64 and command_size == 72:
            segment_name = bytes(data[cursor + 8:cursor + 24]).rstrip(b"\0")
            if segment_name == b"__LINKEDIT":
                virtual_size, file_offset, file_size = struct.unpack_from("<QQQ", data, cursor + 32)
                linkedit_commands.append((cursor, virtual_size, file_offset, file_size))
        cursor += command_size
    if cursor != commands_end:
        raise EquivalenceError(f"Mach-O load command count and size disagree: {path}")
    if len(signature_commands) != 1:
        raise EquivalenceError(f"Mach-O must contain exactly one LC_CODE_SIGNATURE: {path}")
    if len(linkedit_commands) != 1:
        raise EquivalenceError(f"Mach-O must contain exactly one __LINKEDIT segment: {path}")
    command_offset, data_offset, data_size = signature_commands[0]
    if data_offset < commands_end or data_size < 1 or data_offset + data_size != len(data):
        raise EquivalenceError(f"Mach-O signature blob must be the complete terminal region: {path}")
    linkedit_offset, virtual_size, file_offset, file_size = linkedit_commands[0]
    if file_offset > data_offset or file_offset + file_size != len(data) or virtual_size < file_size:
        raise EquivalenceError(f"Mach-O __LINKEDIT does not cover the terminal signature region: {path}")

    # A Developer ID CMS is larger than an ad-hoc signature. codesign therefore
    # changes both LC_CODE_SIGNATURE and the signature-dependent __LINKEDIT
    # virtual/file sizes even when the executable payload is identical. Derive
    # both sizes from the unsigned prefix before hashing; all other load-command
    # fields and every byte before data_offset remain covered by SHA-256.
    unsigned_linkedit_size = data_offset - file_offset
    struct.pack_into("<Q", data, linkedit_offset + 32, unsigned_linkedit_size)
    struct.pack_into("<Q", data, linkedit_offset + 48, unsigned_linkedit_size)
    data[command_offset:command_offset + 16] = b"\0" * 16
    canonical = bytes(data[:data_offset])
    return sha256(canonical), len(canonical), data_size


def is_macho(path: Path) -> bool:
    if path.stat().st_size < 4:
        return False
    with path.open("rb") as handle:
        return struct.unpack("<I", handle.read(4))[0] == MH_MAGIC_64


def kind(metadata: os.stat_result) -> str:
    if stat.S_ISDIR(metadata.st_mode):
        return "directory"
    if stat.S_ISREG(metadata.st_mode):
        return "file"
    if stat.S_ISLNK(metadata.st_mode):
        return "symlink"
    raise EquivalenceError("Unsupported filesystem object")


def inventory(root: Path) -> dict[str, dict[str, object]]:
    if root.is_symlink() or not root.is_dir() or root.resolve() != root.absolute():
        raise EquivalenceError(f"App root must be a real absolute directory: {root}")
    root_metadata = root.lstat()
    entries: dict[str, dict[str, object]] = {
        ".": {"type": "directory", "mode": format(stat.S_IMODE(root_metadata.st_mode), "04o")},
    }
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        directories.sort()
        files.sort()
        for name in directories + files:
            path = Path(current, name)
            relative = path.relative_to(root).as_posix()
            metadata = path.lstat()
            entry_kind = kind(metadata)
            entry: dict[str, object] = {
                "type": entry_kind,
                "mode": format(stat.S_IMODE(metadata.st_mode), "04o"),
            }
            if entry_kind == "symlink":
                entry["target"] = os.readlink(path)
                if path.is_dir():
                    directories.remove(name)
            elif entry_kind == "file":
                entry["bytes"] = metadata.st_size
                parts = tuple(relative.split("/"))
                if parts[-2:] == SIGNATURE_METADATA_SUFFIX:
                    entry["contentPolicy"] = "signature-metadata"
                elif is_macho(path):
                    digest, canonical_bytes, signature_bytes = canonical_macho(path)
                    entry.update({
                        "contentPolicy": "arm64-macho-with-normalized-code-signature",
                        "canonicalSha256": digest,
                        "canonicalBytes": canonical_bytes,
                        "signatureBytes": signature_bytes,
                    })
                else:
                    entry.update({"contentPolicy": "exact", "sha256": sha256(path.read_bytes())})
            entries[relative] = entry
    return entries


def exact_tree_inventory(root: Path) -> dict[str, object]:
    if root.is_symlink() or not root.is_dir() or root.resolve() != root.absolute():
        raise EquivalenceError(f"Tree root must be a real absolute directory: {root}")
    root_metadata = root.lstat()
    entries: dict[str, dict[str, object]] = {
        ".": {"type": "directory", "mode": format(stat.S_IMODE(root_metadata.st_mode), "04o")},
    }
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        directories.sort()
        files.sort()
        for name in directories + files:
            path = Path(current, name)
            relative = path.relative_to(root).as_posix()
            metadata = path.lstat()
            entry_kind = kind(metadata)
            entry: dict[str, object] = {
                "type": entry_kind,
                "mode": format(stat.S_IMODE(metadata.st_mode), "04o"),
            }
            if entry_kind == "symlink":
                entry["target"] = os.readlink(path)
                if path.is_dir():
                    directories.remove(name)
            elif entry_kind == "file":
                entry.update({"bytes": metadata.st_size, "sha256": sha256(path.read_bytes())})
            entries[relative] = entry
    encoded = json.dumps(entries, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return {
        "schemaVersion": 1,
        "policy": "exact-tree-path-type-mode-symlink-content-v1",
        "pathCount": len(entries),
        "inventorySha256": sha256(encoded),
    }


def compare(baseline_root: Path, candidate_root: Path) -> dict[str, object]:
    baseline = inventory(baseline_root)
    candidate = inventory(candidate_root)
    if baseline.keys() != candidate.keys():
        missing = sorted(baseline.keys() - candidate.keys())
        added = sorted(candidate.keys() - baseline.keys())
        raise EquivalenceError(f"App path closure differs (missing={missing[:5]}, added={added[:5]})")
    counts = {"directories": 0, "symlinks": 0, "exactFiles": 0, "normalizedMachOFiles": 0, "signatureMetadataFiles": 0}
    for relative in sorted(baseline):
        before = baseline[relative]
        after = candidate[relative]
        if before["type"] != after["type"] or before["mode"] != after["mode"]:
            raise EquivalenceError(f"Type or mode differs: {relative}")
        entry_type = before["type"]
        if entry_type == "directory":
            counts["directories"] += 1
            continue
        if entry_type == "symlink":
            counts["symlinks"] += 1
            if before["target"] != after["target"]:
                raise EquivalenceError(f"Symlink target differs: {relative}")
            continue
        if before["contentPolicy"] != after["contentPolicy"]:
            raise EquivalenceError(f"File classification differs: {relative}")
        policy = str(before["contentPolicy"])
        if policy == "exact":
            counts["exactFiles"] += 1
            if before["bytes"] != after["bytes"] or before["sha256"] != after["sha256"]:
                raise EquivalenceError(f"Non-signature file bytes differ: {relative}")
        elif policy == "arm64-macho-with-normalized-code-signature":
            counts["normalizedMachOFiles"] += 1
            if before["canonicalBytes"] != after["canonicalBytes"] or before["canonicalSha256"] != after["canonicalSha256"]:
                raise EquivalenceError(f"Mach-O payload differs after LC_CODE_SIGNATURE normalization: {relative}")
        elif policy == "signature-metadata":
            counts["signatureMetadataFiles"] += 1
        else:
            raise EquivalenceError(f"Unknown content policy: {relative}")
    if counts["normalizedMachOFiles"] < 1:
        raise EquivalenceError("No normalized Mach-O payloads were compared")
    def canonical_tree(entries: dict[str, dict[str, object]]) -> str:
        normalized: dict[str, dict[str, object]] = {}
        for relative, entry in entries.items():
            value = dict(entry)
            if value.get("contentPolicy") == "arm64-macho-with-normalized-code-signature":
                value.pop("bytes", None)
                value.pop("signatureBytes", None)
            elif value.get("contentPolicy") == "signature-metadata":
                value.pop("bytes", None)
            normalized[relative] = value
        return sha256(json.dumps(normalized, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    baseline_digest = canonical_tree(baseline)
    candidate_digest = canonical_tree(candidate)
    if baseline_digest != candidate_digest:
        raise EquivalenceError("Canonical app payload inventory differs")
    return {
        "schemaVersion": 1,
        "equivalent": True,
        "policy": "macos-app-payload-excluding-signature-metadata-v1",
        "baselineRootName": baseline_root.name,
        "candidateRootName": candidate_root.name,
        "pathCount": len(baseline),
        "baselineCanonicalInventorySha256": baseline_digest,
        "candidateCanonicalInventorySha256": candidate_digest,
        **counts,
    }


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "canonical-macho":
        path = Path(sys.argv[2]).absolute()
        if path.is_symlink() or not path.is_file() or path.resolve() != path:
            raise SystemExit(f"Mach-O input must be a real absolute file: {path}")
        digest, canonical_bytes, signature_bytes = canonical_macho(path)
        print(json.dumps({
            "schemaVersion": 1,
            "policy": "thin-arm64-macho-terminal-code-signature-v1",
            "canonicalSha256": digest,
            "canonicalBytes": canonical_bytes,
            "signatureBytes": signature_bytes,
        }, separators=(",", ":"), sort_keys=True))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "exact-tree":
        root = Path(sys.argv[2]).absolute()
        print(json.dumps(exact_tree_inventory(root), separators=(",", ":"), sort_keys=True))
        return
    if len(sys.argv) != 4:
        raise SystemExit(
            "Usage: compare-macos-app-payloads.py BASELINE_APP CANDIDATE_APP OUTPUT_JSON\n"
            "   or: compare-macos-app-payloads.py canonical-macho MACHO\n"
            "   or: compare-macos-app-payloads.py exact-tree ROOT"
        )
    baseline = Path(sys.argv[1]).absolute()
    candidate = Path(sys.argv[2]).absolute()
    output = Path(sys.argv[3]).absolute()
    if output.exists() or output.is_symlink():
        raise SystemExit(f"Output must start absent: {output}")
    report = compare(baseline, candidate)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(output, 0o600)


if __name__ == "__main__":
    try:
        main()
    except EquivalenceError as error:
        raise SystemExit(str(error)) from error
