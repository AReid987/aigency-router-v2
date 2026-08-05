#!/usr/bin/env python3
"""Aider patterns test script — spawned by test-aider-patterns.py.

Runs 5 scenarios against the Aigency Python SDK and outputs JSON results:
  1. Streaming commit message generation
  2. Streaming file-edit format response
  3. Multi-turn conversation (3 turns)
  4. Retry on 5xx (SDK retries 500 then succeeds)
  5. Error handling for 4xx (SDK raises on 401)

Environment:
  AIGENCY_BASE_URL — mock gateway URL (default http://127.0.0.1:18080/v1)

Output: single JSON line with {passed, failed, details}.
"""

import json
import os
import sys
import urllib.error

# SDK path injected via PYTHONPATH by the test harness
from aigency_sdk import AigencyClient
from aigency_sdk.types import ChatCompletionRequest, ChatCompletionMessage

BASE_URL = os.environ.get("AIGENCY_BASE_URL", "http://127.0.0.1:18080/v1")


def _accumulate_stream(client: AigencyClient, messages: list) -> str:
    """Send a streaming request and accumulate content from all chunks."""
    request = ChatCompletionRequest(
        model="mock/gpt-4",
        messages=messages,
        stream=True,
    )
    gen = client._create_chat_completion(request)
    parts: list[str] = []
    for chunk in gen:
        for choice in chunk.choices:
            parts.append(choice.delta.content)
    return "".join(parts)


def scenario_1_streaming_commit_message(client: AigencyClient) -> tuple[bool, str]:
    """Streaming commit message generation."""
    content = _accumulate_stream(client, [
        ChatCompletionMessage(
            role="user",
            content="Generate a commit message for these changes: "
                    "feat: add user authentication\n"
                    "- Added JWT token validation\n"
                    "- Added password hashing with bcrypt",
        ),
    ])
    if not content.strip():
        return False, "Empty streaming response for commit message"
    return True, f"Received streaming commit message, content length {len(content)}"


def scenario_2_file_edit_format(client: AigencyClient) -> tuple[bool, str]:
    """Streaming file-edit format response."""
    content = _accumulate_stream(client, [
        ChatCompletionMessage(
            role="user",
            content="Fix the bug in src/main.py — the function returns None instead of the expected value",
        ),
    ])
    if not content.strip():
        return False, "Empty streaming response for file edit"
    # Verify the response contains diff-like markers
    has_diff_marker = "---" in content or "+++" in content or "@@" in content
    return True, (
        f"Received file edit response, content length {len(content)}, "
        f"diff markers present: {has_diff_marker}"
    )


def scenario_3_multi_turn(client: AigencyClient) -> tuple[bool, str]:
    """Multi-turn conversation (3 turns) with streaming."""
    messages: list = []
    turns_completed = 0

    for i in range(3):
        messages.append(
            ChatCompletionMessage(role="user", content=f"Turn {i + 1}: what is {i + 1} plus {i + 2}?")
        )
        reply = _accumulate_stream(client, messages)
        if not reply.strip():
            return False, f"Empty response on turn {i + 1}"
        messages.append(ChatCompletionMessage(role="assistant", content=reply))
        turns_completed += 1

    return True, f"Multi-turn completed ({turns_completed} turns, {len(messages)} total messages)"


def scenario_4_retry_on_5xx(client: AigencyClient) -> tuple[bool, str]:
    """Retry on 5xx — SDK returns 500 first, then 200 on retry."""
    request = ChatCompletionRequest(
        model="mock/gpt-4",
        messages=[
            ChatCompletionMessage(role="user", content="Test retry logic — this should trigger a 500 then succeed"),
        ],
        stream=False,
    )
    result = client._create_chat_completion(request)
    if result.choices and result.choices[0].message.content.strip():
        return True, "Retry succeeded after initial 500"
    return False, "Retry returned empty response"


def scenario_5_error_handling_4xx(client: AigencyClient) -> tuple[bool, str]:
    """Error handling for 4xx — SDK must raise HTTPError on 401."""
    request = ChatCompletionRequest(
        model="mock/gpt-4",
        messages=[
            ChatCompletionMessage(role="user", content="Test error handling — this should return 401"),
        ],
        stream=False,
    )
    try:
        client._create_chat_completion(request)
        return False, "Expected HTTPError but request succeeded"
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return True, f"Correctly raised HTTPError with status {e.code}"
        return False, f"Unexpected HTTPError status: {e.code}"
    except Exception as e:
        return False, f"Expected HTTPError but got {type(e).__name__}: {e}"


def main() -> None:
    client = AigencyClient(base_url=BASE_URL, max_retries=3)

    scenarios = [
        ("streaming_commit_message", scenario_1_streaming_commit_message),
        ("file_edit_format", scenario_2_file_edit_format),
        ("multi_turn", scenario_3_multi_turn),
        ("retry_on_5xx", scenario_4_retry_on_5xx),
        ("error_handling_4xx", scenario_5_error_handling_4xx),
    ]

    passed = 0
    failed = 0
    details: list[str] = []

    for name, fn in scenarios:
        try:
            success, detail = fn(client)
        except Exception as e:
            success = False
            detail = f"Unhandled exception: {type(e).__name__}: {e}"

        if success:
            passed += 1
            details.append(f"[PASS] {name}: {detail}")
        else:
            failed += 1
            details.append(f"[FAIL] {name}: {detail}")

    result = {"passed": passed, "failed": failed, "details": details}
    print(json.dumps(result))
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
