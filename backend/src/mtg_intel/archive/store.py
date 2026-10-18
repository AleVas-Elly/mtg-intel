"""Where the archive lives. One publish = one commit (D18)."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Protocol

from mtg_intel.archive.manifest import Manifest

MANIFEST_PATH = "manifest.json"


class Store(Protocol):
    def read_manifest(self) -> Manifest: ...

    def publish(self, files: list[tuple[str, Path]], manifest: Manifest, message: str) -> None:
        """Write `files` (path in archive, local file) and the manifest together."""
        ...


class LocalStore:
    """A plain folder. Used for tests and local dry runs."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def read_manifest(self) -> Manifest:
        path = self.root / MANIFEST_PATH
        return Manifest.from_json(path.read_text()) if path.exists() else Manifest()

    def publish(self, files: list[tuple[str, Path]], manifest: Manifest, message: str) -> None:
        for path_in_archive, local in files:
            dest = self.root / path_in_archive
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(local, dest)
        (self.root / MANIFEST_PATH).parent.mkdir(parents=True, exist_ok=True)
        (self.root / MANIFEST_PATH).write_text(manifest.to_json())


class HfStore:
    """A private Hugging Face dataset (D9)."""

    def __init__(self, repo_id: str, token: str) -> None:
        from huggingface_hub import HfApi

        self.repo_id = repo_id
        self.token = token
        self.api = HfApi(token=token)

    def read_manifest(self) -> Manifest:
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import EntryNotFoundError

        try:
            path = hf_hub_download(
                self.repo_id,
                MANIFEST_PATH,
                repo_type="dataset",
                token=self.token,
                force_download=True,
            )
        except EntryNotFoundError:
            return Manifest()
        return Manifest.from_json(Path(path).read_text())

    def publish(self, files: list[tuple[str, Path]], manifest: Manifest, message: str) -> None:
        from huggingface_hub import CommitOperationAdd

        operations = [CommitOperationAdd(path_in_repo=p, path_or_fileobj=str(local)) for p, local in files]
        operations.append(
            CommitOperationAdd(path_in_repo=MANIFEST_PATH, path_or_fileobj=manifest.to_json().encode())
        )
        self.api.create_commit(
            self.repo_id,
            operations,
            commit_message=message,
            repo_type="dataset",
        )
