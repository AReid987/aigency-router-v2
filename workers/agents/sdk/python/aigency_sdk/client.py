"""AigencyClient — OpenAI-compatible chat completions client.

Uses stdlib only (urllib.request) with auto-retry on 5xx,
SSE streaming support, and injectable urlopen for testability.
"""

from __future__ import annotations

import json
import time
import urllib.request
import urllib.error
from typing import Callable, Generator

from .types import (
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    Role,
)


Urlopen = Callable[..., urllib.request.OpenerDirector]


def _default_urlopen(
    url: str,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    method: str = "POST",
) -> urllib.request.OpenerDirector:
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    return urllib.request.urlopen(req)


def _build_headers(api_key: str | None) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _parse_sse(line: str) -> dict | None:
    """Parse a single SSE line (data: {...}) and return the parsed dict."""
    if line.startswith("data: "):
        payload = line[6:].strip()
        if payload == "[DONE]":
            return None
        return json.loads(payload)
    return None


def _parse_sse_stream(body: bytes) -> Generator[ChatCompletionChunk, None, None]:
    """Parse SSE response body into ChatCompletionChunk generator."""
    raw = body.decode("utf-8")
    for block in raw.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        for line in block.split("\n"):
            parsed = _parse_sse(line.strip())
            if parsed is None:
                return
            if parsed is not None:
                yield ChatCompletionChunk.from_dict(parsed)


class _CompletionsCreate:
    """Sub-resource: client.chat.completions.create"""

    def __init__(self, client: AigencyClient):
        self._client = client

    def create(
        self,
        params: ChatCompletionRequest,
    ) -> ChatCompletionResponse | Generator[ChatCompletionChunk, None, None]:
        return self._client._create_chat_completion(params)


class _Completions:
    """Sub-resource: client.chat.completions"""

    def __init__(self, client: AigencyClient):
        self.completions = _CompletionsCreate(client)


class AigencyClient:
    """OpenAI-compatible chat completions client for Aigency Router.

    Args:
        base_url: Base URL of the Aigency Router gateway.
        api_key: Optional API key for authentication.
        max_retries: Maximum number of retries on 5xx responses (default: 3).
        urlopen: Injectable urlopen function (for testing).
    """

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        max_retries: int = 3,
        urlopen: Urlopen | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.max_retries = max_retries
        self._urlopen = urlopen or _default_urlopen
        self.chat = _Completions(self)

    def _request(
        self,
        method: str,
        path: str,
        body: dict | None = None,
    ) -> urllib.request.OpenerDirector:
        url = f"{self.base_url}{path}"
        headers = _build_headers(self.api_key)
        data = json.dumps(body).encode("utf-8") if body else None

        last_error: Exception | None = None
        retries = 0

        while retries <= self.max_retries:
            try:
                resp = self._urlopen(url, data=data, headers=headers, method=method)
                return resp
            except urllib.error.HTTPError as e:
                code = e.code
                if 500 <= code < 600 and retries < self.max_retries:
                    retries += 1
                    wait = 0.1 * (2 ** (retries - 1))  # 0.1s, 0.2s, 0.4s
                    time.sleep(wait)
                    last_error = e
                    continue
                raise
            except urllib.error.URLError as e:
                last_error = e
                raise

        raise last_error or RuntimeError("unexpected request failure")

    def _create_chat_completion(
        self,
        params: ChatCompletionRequest,
    ) -> ChatCompletionResponse | Generator[ChatCompletionChunk, None, None]:
        body = {
            "model": params.model,
            "messages": [{"role": m.role, "content": m.content} for m in params.messages],
            "stream": params.stream,
        }
        if params.max_tokens is not None:
            body["max_tokens"] = params.max_tokens
        if params.temperature is not None:
            body["temperature"] = params.temperature

        resp = self._request("POST", "/v1/chat/completions", body=body)

        if params.stream:
            return self._handle_stream(resp)
        return self._handle_non_stream(resp)

    def _handle_non_stream(
        self,
        resp: urllib.request.OpenerDirector,
    ) -> ChatCompletionResponse:
        body = resp.read()
        data = json.loads(body.decode("utf-8"))
        return ChatCompletionResponse.from_dict(data)

    def _handle_stream(
        self,
        resp: urllib.request.OpenerDirector,
    ) -> Generator[ChatCompletionChunk, None, None]:
        return _parse_sse_stream(resp.read())
