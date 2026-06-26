"""Integration tests for Python SDK aider usage patterns.

Uses a MockAigencyServer to simulate the gateway and spawns
aider_test_script.py as a child process running the real Python SDK.

Test cases:
  1. Streaming aider-style commit message generation works
  2. File edit format response parsed correctly
  3. Multi-turn context preserved across requests
  4. Retry on 5xx works (Python SDK retries 500 then succeeds)
  5. Error handling for 4xx (Python SDK raises on 401)
  6. End-to-end JSON parses correctly
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import pytest

# ── Paths ──────────────────────────────────────────────────────────────────

SCRIPT_PATH = os.path.join(os.path.dirname(__file__), "scripts", "aider_test_script.py")
SDK_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "workers", "agents", "sdk", "python")
)


# ── Mock HTTP Server ───────────────────────────────────────────────────────


class MockAigencyHandler(BaseHTTPRequestHandler):
    """Mock Aigency gateway HTTP handler.

    Uses class-level shared state to track requests across handler instances
    (BaseHTTPRequestHandler creates a new instance per request).
    """

    request_log: list[dict] = []  # Shared across all instances

    # ── Helpers ──────────────────────────────────────────────────────────

    def _get_content(self, data: dict) -> str:
        return " ".join(m.get("content", "") for m in data.get("messages", []))

    def _build_response_text(self, content: str) -> str:
        if "commit message" in content.lower():
            return (
                "feat: add user authentication\n\n"
                "Implemented JWT token validation and "
                "password hashing with bcrypt"
            )
        if "fix the bug" in content.lower() or "src/main.py" in content:
            return (
                "--- a/src/main.py\n"
                "+++ b/src/main.py\n"
                "@@ -1,5 +1,5 @@\n"
                "-def buggy_function():\n"
                "+def fixed_function():\n"
                "     pass"
            )
        return f"Mock response to: {content[:80]}"

    def _response_id(self) -> str:
        return f"chatcmpl-mock-{int(time.time() * 1000)}"

    # ── Response writers ─────────────────────────────────────────────────

    def _send_stream(self, data: dict) -> None:
        content = self._get_content(data)
        response_text = self._build_response_text(content)
        resp_id = self._response_id()

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        words = response_text.split()
        for i, word in enumerate(words):
            is_last = i == len(words) - 1
            space = " " if not is_last else ""

            if i == 0:
                delta = {"role": "assistant", "content": word + space}
            else:
                delta = {"content": word + space}

            chunk = {
                "id": resp_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "mock/gpt-4",
                "choices": [
                    {
                        "index": 0,
                        "delta": delta,
                        "finish_reason": "stop" if is_last else None,
                    }
                ],
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
            time.sleep(0.005)

        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _send_json(self, data: dict) -> None:
        content = self._get_content(data)
        resp_id = self._response_id()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()

        response = {
            "id": resp_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "mock/gpt-4",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": f"Mock response to: {content[:80]}",
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        }
        self.wfile.write(json.dumps(response).encode())

    def _send_error(self, code: int, message: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps({"error": {"message": message, "type": "server_error"}}).encode()
        )

    # ── Route ────────────────────────────────────────────────────────────

    def do_POST(self) -> None:
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        data = json.loads(body)
        stream = data.get("stream", False)
        content = self._get_content(data)

        type(self).request_log.append(
            {
                "stream": stream,
                "content": content,
                "timestamp": time.time(),
            }
        )

        # ── Retry scenario: first request with "retry logic" returns 500 ──
        if "retry logic" in content.lower():
            retry_requests = [
                r
                for r in type(self).request_log
                if "retry logic" in r["content"].lower()
            ]
            if len(retry_requests) <= 1:
                self._send_error(500, "Internal Server Error")
                return

        # ── Error handling scenario: requests with "error handling" return 401 ──
        if "error handling" in content.lower():
            self._send_error(401, "Unauthorized")
            return

        # ── Normal response ───────────────────────────────────────────────
        if stream:
            self._send_stream(data)
        else:
            self._send_json(data)

    def log_message(self, format: str, *args: object) -> None:
        pass  # Suppress HTTP server logs


class MockAigencyServer:
    """Mock Aigency gateway HTTP server for testing."""

    def __init__(self) -> None:
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.url: str = ""
        MockAigencyHandler.request_log = []

    def start(self, host: str = "127.0.0.1") -> str:
        self._server = HTTPServer((host, 0), MockAigencyHandler)
        port = self._server.server_address[1]
        self.url = f"http://{host}:{port}"

        self._thread = threading.Thread(target=self._server.serve_forever)
        self._thread.daemon = True
        self._thread.start()

        return self.url

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self) -> MockAigencyServer:
        self.start()
        return self

    def __exit__(self, *args: object) -> None:
        self.stop()


# ── Fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture
def mock_server() -> MockAigencyServer:
    server = MockAigencyServer()
    server.start()
    yield server
    server.stop()


# ── Helpers ────────────────────────────────────────────────────────────────


def _build_env(server_url: str) -> dict[str, str]:
    """Build environment dict for the spawned script."""
    existing = os.environ.get("PYTHONPATH", "")
    pythonpath = (
        SDK_PATH + (os.pathsep + existing) if existing else SDK_PATH
    )
    return {
        **os.environ,
        "AIGENCY_BASE_URL": server_url,
        "PYTHONPATH": pythonpath,
    }


def _run_script(env: dict[str, str]) -> subprocess.CompletedProcess:
    """Spawn the aider test script and return the result."""
    return subprocess.run(
        [sys.executable, SCRIPT_PATH],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )


# ── Tests ──────────────────────────────────────────────────────────────────


class TestAiderPatterns:
    """Integration tests for Python SDK aider usage patterns."""

    def test_e2e_json_parses_correctly(self, mock_server: MockAigencyServer) -> None:
        """Test 6: End-to-end JSON parses correctly."""
        result = _run_script(_build_env(mock_server.url))

        assert result.returncode == 0, (
            f"Script failed (exit {result.returncode})\n"
            f"stdout: {result.stdout}\n"
            f"stderr: {result.stderr}"
        )

        output = json.loads(result.stdout.strip())
        assert isinstance(output, dict), "Output must be a dict"
        assert "passed" in output, "Output must contain 'passed'"
        assert "failed" in output, "Output must contain 'failed'"
        assert "details" in output, "Output must contain 'details'"

    def test_streaming_commit_message(self, mock_server: MockAigencyServer) -> None:
        """Test 1: Streaming aider-style commit message generation works."""
        result = _run_script(_build_env(mock_server.url))
        assert result.returncode == 0

        output = json.loads(result.stdout.strip())
        matching = [d for d in output["details"] if "streaming_commit_message" in d]
        assert len(matching) == 1, "Expected exactly one streaming_commit_message detail"
        assert matching[0].startswith("[PASS]"), (
            f"Commit message streaming failed: {matching[0]}"
        )

    def test_file_edit_format(self, mock_server: MockAigencyServer) -> None:
        """Test 2: File edit format response parsed correctly."""
        result = _run_script(_build_env(mock_server.url))
        assert result.returncode == 0

        output = json.loads(result.stdout.strip())
        matching = [d for d in output["details"] if "file_edit_format" in d]
        assert len(matching) == 1, "Expected exactly one file_edit_format detail"
        assert matching[0].startswith("[PASS]"), (
            f"File edit format failed: {matching[0]}"
        )

    def test_multi_turn_context(self, mock_server: MockAigencyServer) -> None:
        """Test 3: Multi-turn context preserved across requests."""
        result = _run_script(_build_env(mock_server.url))
        assert result.returncode == 0

        output = json.loads(result.stdout.strip())
        matching = [d for d in output["details"] if "multi_turn" in d]
        assert len(matching) == 1, "Expected exactly one multi_turn detail"
        assert matching[0].startswith("[PASS]"), (
            f"Multi-turn failed: {matching[0]}"
        )

    def test_retry_on_5xx(self, mock_server: MockAigencyServer) -> None:
        """Test 4: Retry on 5xx works (SDK retries 500 then succeeds)."""
        result = _run_script(_build_env(mock_server.url))
        assert result.returncode == 0

        output = json.loads(result.stdout.strip())
        matching = [d for d in output["details"] if "retry_on_5xx" in d]
        assert len(matching) == 1, "Expected exactly one retry_on_5xx detail"
        assert matching[0].startswith("[PASS]"), (
            f"Retry on 5xx failed: {matching[0]}"
        )

        # Verify the mock server actually received a retry
        log = MockAigencyHandler.request_log
        retry_attempts = [r for r in log if "retry logic" in r["content"].lower()]
        assert len(retry_attempts) >= 2, (
            f"Expected at least 2 retry requests, got {len(retry_attempts)}"
        )

    def test_error_handling_4xx(self, mock_server: MockAigencyServer) -> None:
        """Test 5: Error handling for 4xx (SDK raises on 401)."""
        result = _run_script(_build_env(mock_server.url))
        assert result.returncode == 0

        output = json.loads(result.stdout.strip())
        matching = [d for d in output["details"] if "error_handling_4xx" in d]
        assert len(matching) == 1, "Expected exactly one error_handling_4xx detail"
        assert matching[0].startswith("[PASS]"), (
            f"Error handling for 4xx failed: {matching[0]}"
        )

        # Verify the mock server actually returned a 401
        log = MockAigencyHandler.request_log
        error_requests = [r for r in log if "error handling" in r["content"].lower()]
        assert len(error_requests) >= 1, (
            "Expected at least one error handling request to the server"
        )
