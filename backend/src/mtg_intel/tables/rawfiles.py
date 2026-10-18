"""Reading raw archive files as they are stored (D25): zstd-compressed or byte-for-byte."""

from __future__ import annotations

import lzma
from pathlib import Path
from typing import BinaryIO

import zstandard


def open_raw(path: Path) -> BinaryIO:
    """A binary stream of the file's original content."""
    if path.suffix == ".zst":
        return zstandard.ZstdDecompressor().stream_reader(path.open("rb"), closefd=True)
    if path.suffix == ".xz":
        return lzma.open(path, "rb")
    return path.open("rb")


def read_bytes(path: Path) -> bytes:
    with open_raw(path) as f:
        return f.read()
