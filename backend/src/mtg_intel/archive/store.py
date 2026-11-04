"""Where the archive lives. One publish = one commit (D18)."""

from __future__ import annotations

import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from mtg_intel.archive.manifest import Manifest

MANIFEST_PATH = "manifest.json"
HF_RETRY_WAITS = (5, 20)  # seconds before the second and third try of a Hugging Face call


def _transient(error: BaseException) -> bool:
    """A Hugging Face error worth retrying: network trouble, 429 or a 5xx, also when the library
    wraps it (a failed forced download raises ValueError from the HTTP error)."""
    import httpx
    from huggingface_hub.errors import HfHubHTTPError

    seen: BaseException | None = error
    while seen is not None:
        if isinstance(seen, httpx.TransportError):
            return True
        if isinstance(seen, HfHubHTTPError):
            response = getattr(seen, "response", None)
            status = getattr(response, "status_code", None)
            return status is not None and (status == 429 or status >= 500)
        seen = seen.__cause__ or seen.__context__
    return False


def hf_retry[T](call: Callable[[], T], sleep: Callable[[float], None] = time.sleep) -> T:
    """Run one Hugging Face call, retrying passing outages (a 504 crashed a deal check on 2026-11-02)."""
    for wait in HF_RETRY_WAITS:
        try:
            return call()
        except Exception as e:
            if not _transient(e):
                raise
            print(f"Hugging Face hiccup ({type(e).__name__}), trying again in {wait} s")
            sleep(wait)
    return call()


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
            path = hf_retry(lambda: hf_hub_download(
                self.repo_id,
                MANIFEST_PATH,
                repo_type="dataset",
                token=self.token,
                force_download=True,
            ))
        except EntryNotFoundError:
            return Manifest()
        return Manifest.from_json(Path(path).read_text())

    def publish(self, files: list[tuple[str, Path]], manifest: Manifest, message: str) -> None:
        from huggingface_hub import CommitOperationAdd

        operations = [CommitOperationAdd(path_in_repo=p, path_or_fileobj=str(local)) for p, local in files]
        operations.append(
            CommitOperationAdd(path_in_repo=MANIFEST_PATH, path_or_fileobj=manifest.to_json().encode())
        )
        hf_retry(lambda: self.api.create_commit(
            self.repo_id,
            operations,
            commit_message=message,
            repo_type="dataset",
        ))
