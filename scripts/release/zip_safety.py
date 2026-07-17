#!/usr/bin/env python3
"""Small fail-closed ZIP central-directory preflight shared by release gates."""

from __future__ import annotations

import os
import struct
from typing import Optional


EOCD_SIGNATURE = b"PK\x05\x06"
ZIP64_EOCD_SIGNATURE = b"PK\x06\x06"
ZIP64_LOCATOR_SIGNATURE = b"PK\x06\x07"
EOCD = struct.Struct("<4sHHHHIIH")
MAXIMUM_COMMENT_BYTES = 65535


def preflight_zip_central_directory(
    path: str,
    *,
    maximum_archive_bytes: int,
    maximum_entries: int,
    maximum_directory_bytes: int,
    expected_entries: Optional[int] = None,
) -> dict:
    metadata = os.lstat(path)
    if not os.path.isfile(path) or os.path.islink(path) or metadata.st_nlink != 1:
        raise ValueError("ZIP archive must be one real regular file")
    if metadata.st_size < EOCD.size or metadata.st_size > maximum_archive_bytes:
        raise ValueError("ZIP archive exceeds its size limit")

    tail_size = min(metadata.st_size, EOCD.size + MAXIMUM_COMMENT_BYTES)
    with open(path, "rb", buffering=0) as source:
        source.seek(metadata.st_size - tail_size)
        tail = source.read(tail_size)
    relative_offset = tail.rfind(EOCD_SIGNATURE)
    if relative_offset < 0 or len(tail) - relative_offset < EOCD.size:
        raise ValueError("ZIP end-of-central-directory record is missing")
    eocd_offset = metadata.st_size - tail_size + relative_offset
    fields = EOCD.unpack_from(tail, relative_offset)
    (
        signature,
        disk_number,
        central_disk_number,
        disk_entries,
        total_entries,
        directory_bytes,
        directory_offset,
        comment_bytes,
    ) = fields
    if signature != EOCD_SIGNATURE:
        raise ValueError("ZIP end-of-central-directory signature is invalid")
    if comment_bytes != 0 or eocd_offset + EOCD.size != metadata.st_size:
        raise ValueError("ZIP comments or trailing bytes are forbidden")
    if disk_number != 0 or central_disk_number != 0 or disk_entries != total_entries:
        raise ValueError("Multi-disk ZIP archives are forbidden")
    zip64_locator_offset = relative_offset - 20
    has_zip64_locator = (
        zip64_locator_offset >= 0
        and tail[zip64_locator_offset:zip64_locator_offset + len(ZIP64_LOCATOR_SIGNATURE)]
        == ZIP64_LOCATOR_SIGNATURE
    )
    if (total_entries == 0xFFFF or directory_bytes == 0xFFFFFFFF or directory_offset == 0xFFFFFFFF
            or has_zip64_locator):
        raise ValueError("ZIP64 archives are forbidden")
    if total_entries <= 0 or total_entries > maximum_entries:
        raise ValueError("ZIP central-directory entry count exceeds its limit")
    if expected_entries is not None and total_entries != expected_entries:
        raise ValueError("ZIP central-directory entry count does not match the exact closure")
    if directory_bytes <= 0 or directory_bytes > maximum_directory_bytes:
        raise ValueError("ZIP central directory exceeds its byte limit")
    if directory_offset <= 0 or directory_offset + directory_bytes != eocd_offset:
        raise ValueError("ZIP central-directory bounds are inconsistent")

    return {
        "archiveBytes": metadata.st_size,
        "entries": total_entries,
        "centralDirectoryBytes": directory_bytes,
        "centralDirectoryOffset": directory_offset,
    }
