import httpx
import pytest
from huggingface_hub.errors import EntryNotFoundError, HfHubHTTPError

from mtg_intel.archive.store import hf_retry


def http_error(status, cls=HfHubHTTPError):
    request = httpx.Request("GET", "https://huggingface.co/x")
    return cls(f"HTTP {status}", response=httpx.Response(status, request=request))


def flaky(errors, value="ok"):
    calls = []

    def call():
        calls.append(1)
        if len(calls) <= len(errors):
            raise errors[len(calls) - 1]
        return value
    return call, calls


def test_retries_server_errors_and_network_trouble_even_when_wrapped():
    wrapped = ValueError("Force download failed due to the above error.")
    wrapped.__cause__ = http_error(504)
    call, calls = flaky([wrapped, httpx.ConnectError("down")])
    assert hf_retry(call, sleep=lambda s: None) == "ok" and len(calls) == 3


def test_gives_up_after_three_tries():
    call, calls = flaky([http_error(502)] * 3)
    with pytest.raises(HfHubHTTPError):
        hf_retry(call, sleep=lambda s: None)
    assert len(calls) == 3


def test_missing_files_and_refusals_are_not_retried():
    for error in (EntryNotFoundError("gone"), http_error(404), http_error(401), KeyError("x")):
        call, calls = flaky([error])
        with pytest.raises(type(error)):
            hf_retry(call, sleep=lambda s: None)
        assert len(calls) == 1
