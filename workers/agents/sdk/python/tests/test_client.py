"""Tests for the Aigency Python SDK."""

import json
import urllib.error
from io import BytesIO
from typing import Any

import pytest

from aigency_sdk import (
    AigencyClient,
    ChatCompletionChunk,
    ChatCompletionMessage,
    ChatCompletionRequest,
    ChatCompletionResponse,
    get_quota_status,
)
from aigency_sdk.types import Role


# ── Helpers ──────────────────────────────────────────────────────────

class FakeResponse:
    """Mimics urllib.request.urlopen return value."""

    def __init__(self, status: int, body: bytes, headers: dict[str, str] | None = None):
        self.status = status
        self._body = body
        self.headers = headers or {}

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: Any) -> None:
        pass


class FakeHTTPError(urllib.error.HTTPError):
    """Mimics a urllib HTTP error with a given status code."""

    def __init__(self, code: int, body: bytes = b"{}"):
        self.code = code
        self._body = body
        # HTTPError needs a file-like body for read()
        super().__init__(
            f"http://fake/{code}", code, f"error {code}",
            {}, BytesIO(body),
        )


_FAKE_COMPLETION_BODY = {
    "id": "chatcmpl-fake123",
    "object": "chat.completion",
    "created": 1718000000,
    "model": "gpt-4",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "Hello!"},
            "finish_reason": "stop",
        },
    ],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
}


def _make_fake_urlopen(
    *,
    status: int = 200,
    body: bytes | None = None,
    sse_lines: list[str] | None = None,
    fail_map: list[tuple[int, bytes]] | None = None,
) -> Any:
    """Build a urlopen function with configurable behavior.

    Args:
        status: HTTP status for simple responses.
        body: Response body for simple responses.
        sse_lines: If set, returns an SSE response by joining lines.
        fail_map: Sequence of (status, body) pairs consumed FIFO.
                  When exhausted, falls back to status/body/sse.
    """
    call_count = [0]

    def fake_urlopen(
        url: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        method: str = "POST",
    ) -> FakeResponse:
        idx = call_count[0]
        call_count[0] += 1

        # If fail_map is provided, consume it FIFO
        if fail_map and idx < len(fail_map):
            code, resp_body = fail_map[idx]
            if 400 <= code < 600:
                raise FakeHTTPError(code, resp_body)
            return FakeResponse(code, resp_body)

        # Standard response
        if sse_lines is not None:
            return FakeResponse(200, "".join(sse_lines).encode("utf-8"))
        return FakeResponse(status, body or json.dumps(_FAKE_COMPLETION_BODY).encode("utf-8"))

    return fake_urlopen


# ── Tests ────────────────────────────────────────────────────────────

class TestNonStreaming:
    """Non-streaming chat completion request."""

    def test_returns_parsed_response(self) -> None:
        """Mock returns JSON, verify parsed ChatCompletionResponse."""
        urlopen = _make_fake_urlopen()
        client = AigencyClient(base_url="http://fake.api", urlopen=urlopen)

        req = ChatCompletionRequest(
            model="gpt-4",
            messages=[ChatCompletionMessage(role="user", content="Hi")],
            stream=False,
        )
        result = client.chat.completions.create(req)
        assert isinstance(result, ChatCompletionResponse)
        assert result.id == "chatcmpl-fake123"
        assert result.model == "gpt-4"
        assert len(result.choices) == 1
        assert result.choices[0].message.content == "Hello!"
        assert result.choices[0].message.role == "assistant"
        assert result.choices[0].finish_reason == "stop"
        assert result.usage is not None
        assert result.usage.total_tokens == 15

    def test_passes_headers_and_body(self) -> None:
        """Verify the request includes auth header and JSON body."""
        captured: dict[str, Any] = {}

        def capturing_urlopen(url, data=None, headers=None, method="POST"):
            captured["url"] = url
            captured["headers"] = headers
            captured["body"] = json.loads(data) if data else None
            return _make_fake_urlopen()(url, data, headers, method)

        client = AigencyClient(
            base_url="http://fake.api",
            api_key="sk-test-key",
            urlopen=capturing_urlopen,
        )
        req = ChatCompletionRequest(
            model="gpt-4",
            messages=[ChatCompletionMessage(role="user", content="Hi")],
        )
        client.chat.completions.create(req)

        assert captured["url"] == "http://fake.api/v1/chat/completions"
        assert captured["headers"]["Authorization"] == "Bearer sk-test-key"
        assert captured["body"]["model"] == "gpt-4"
        assert captured["body"]["messages"] == [{"role": "user", "content": "Hi"}]
        assert captured["body"]["stream"] is False


class TestStreaming:
    """Streaming chat completion request."""

    def test_returns_chunk_generator(self) -> None:
        """Mock returns SSE, verify generator yields ChatCompletionChunks."""
        sse = (
            'data: {"id":"chunk-1","object":"chat.completion.chunk","created":1718000000,'
            '"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n'
            'data: {"id":"chunk-1","object":"chat.completion.chunk","created":1718000000,'
            '"model":"gpt-4","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n'
            "data: [DONE]\n\n"
        )
        urlopen = _make_fake_urlopen(sse_lines=[sse])
        client = AigencyClient(base_url="http://fake.api", urlopen=urlopen)

        req = ChatCompletionRequest(
            model="gpt-4",
            messages=[ChatCompletionMessage(role="user", content="Hi")],
            stream=True,
        )
        result = client.chat.completions.create(req)
        chunks = list(result)

        assert len(chunks) == 2
        assert all(isinstance(c, ChatCompletionChunk) for c in chunks)
        assert chunks[0].choices[0].delta.content == "Hello"
        assert chunks[1].choices[0].delta.content == " world"


class TestRetry:
    """Auto-retry on 5xx responses."""

    def test_retries_on_5xx_then_succeeds(self) -> None:
        """Mock returns 500 twice then 200, verify retry + success."""
        fail_map = [
            (500, json.dumps({"error": "first"}).encode()),
            (500, json.dumps({"error": "second"}).encode()),
            (200, json.dumps(_FAKE_COMPLETION_BODY).encode()),
        ]
        urlopen = _make_fake_urlopen(fail_map=fail_map)
        client = AigencyClient(base_url="http://fake.api", urlopen=urlopen, max_retries=3)

        req = ChatCompletionRequest(
            model="gpt-4",
            messages=[ChatCompletionMessage(role="user", content="Hi")],
        )
        result = client.chat.completions.create(req)
        assert isinstance(result, ChatCompletionResponse)
        assert result.choices[0].message.content == "Hello!"

    def test_raises_after_exhausting_retries(self) -> None:
        """All 3 attempts return 503, verify exception raised."""
        fail_map = [
            (503, b"{}"),
            (503, b"{}"),
            (503, b"{}"),
            (503, b"{}"),
        ]
        urlopen = _make_fake_urlopen(fail_map=fail_map)
        client = AigencyClient(base_url="http://fake.api", urlopen=urlopen, max_retries=3)

        req = ChatCompletionRequest(
            model="gpt-4",
            messages=[ChatCompletionMessage(role="user", content="Hi")],
        )
        with pytest.raises(urllib.error.HTTPError):
            client.chat.completions.create(req)

    def test_does_not_retry_on_4xx(self) -> None:
        """400 error should raise immediately without retry."""
        fail_map = [
            (400, json.dumps({"error": "bad request"}).encode()),
        ]
        urlopen = _make_fake_urlopen(fail_map=fail_map)
        client = AigencyClient(base_url="http://fake.api", urlopen=urlopen, max_retries=3)

        req = ChatCompletionRequest(
            model="gpt-4",
            messages=[ChatCompletionMessage(role="user", content="Hi")],
        )
        with pytest.raises(urllib.error.HTTPError) as exc_info:
            client.chat.completions.create(req)
        assert exc_info.value.code == 400


class TestQuota:
    """get_quota_status monitoring function."""

    def test_returns_parsed_json(self) -> None:
        """Mock returns quota JSON, verify parsed dict."""
        quota_body = {
            "providers": {
                "groq": {"remaining": 100, "limit": 1000, "reset_at": "2026-01-01T00:00:00Z"},
            },
        }

        call_count = [0]

        def fake_urlopen(url, data=None, headers=None, method="GET"):
            call_count[0] += 1
            assert method == "GET"
            assert url == "http://fake.api/v1/admin/quota"
            return FakeResponse(200, json.dumps(quota_body).encode("utf-8"))

        result = get_quota_status("http://fake.api", urlopen=fake_urlopen)
        assert result["providers"]["groq"]["remaining"] == 100
        assert call_count[0] == 1

    def test_passes_api_key_header(self) -> None:
        """Verify API key is sent in Authorization header."""
        captured_headers: dict[str, str] = {}

        def capturing_urlopen(url, data=None, headers=None, method="GET"):
            captured_headers.update(headers or {})
            return FakeResponse(200, json.dumps({}).encode("utf-8"))

        get_quota_status("http://fake.api", api_key="sk-monitor", urlopen=capturing_urlopen)
        assert captured_headers.get("Authorization") == "Bearer sk-monitor"


class TestConfigFile:
    """aider config example file."""

    def test_config_exists_and_contains_expected_keys(self) -> None:
        """Read the YAML config example, verify structure via string checks."""
        import os

        config_path = os.path.join(
            os.path.dirname(__file__),
            "..",
            "examples",
            "aider",
            "config.example.yaml",
        )
        assert os.path.exists(config_path), f"config file not found: {config_path}"

        with open(config_path) as f:
            content = f.read()

        # Key structural expectations
        assert "AIGENCY_BASE_URL" in content, "should reference AIGENCY_BASE_URL"
        assert "AIGENCY_API_KEY" in content, "should reference AIGENCY_API_KEY"
        assert "openai-api-base" in content or "openai-api-key" in content, (
            "should reference aider config keys"
        )


class TestClientEdgeCases:
    """Edge case behavior of the client."""

    def test_base_url_trailing_slash_stripped(self) -> None:
        """Trailing slash on base_url is stripped before request."""
        captured: dict[str, Any] = {}

        def capturing_urlopen(url, data=None, headers=None, method="POST"):
            captured["url"] = url
            return _make_fake_urlopen()(url, data, headers, method)

        client = AigencyClient(
            base_url="http://fake.api/",
            urlopen=capturing_urlopen,
        )
        req = ChatCompletionRequest(
            model="gpt-4",
            messages=[ChatCompletionMessage(role="user", content="Hi")],
        )
        client.chat.completions.create(req)
        assert not captured["url"].endswith("//v1/chat/completions")
        assert captured["url"] == "http://fake.api/v1/chat/completions"
