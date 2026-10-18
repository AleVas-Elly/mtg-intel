"""The archive manifest: last saved file per source (D19)."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime


@dataclass
class Entry:
    sha256: str  # hash of the downloaded bytes, before any compression
    size: int  # downloaded bytes
    path: str  # path in the archive
    saved_at: str  # ISO 8601, UTC
    url: str

    @property
    def saved_at_dt(self) -> datetime:
        return datetime.fromisoformat(self.saved_at)


@dataclass
class Manifest:
    version: int = 1
    entries: dict[str, Entry] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(
            {"version": self.version, "entries": {k: asdict(v) for k, v in sorted(self.entries.items())}},
            indent=2,
        ) + "\n"

    @classmethod
    def from_json(cls, text: str) -> Manifest:
        data = json.loads(text)
        return cls(
            version=data.get("version", 1),
            entries={k: Entry(**v) for k, v in data.get("entries", {}).items()},
        )
