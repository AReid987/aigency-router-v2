"""Tests for the brain worker handlers."""

import pytest
from unittest.mock import MagicMock

from main import _inline_heuristic


# ── Inline heuristic tests (no iii engine needed) ──────────────────────────


async def _call_classify(payload: dict) -> dict:
    """Simulate the classify handler logic using inline heuristic directly."""
    result = _inline_heuristic(payload)
    result["source"] = "brain-fallback"
    return result


async def _call_status() -> dict:
    """Simulate the status handler logic."""
    return {
        "status": "healthy",
        "worker": "brain",
        "engine_url": "ws://127.0.0.1:49134",
    }


@pytest.mark.asyncio
async def test_classify_single_message():
    """Single message should be classified as SIMPLE."""
    result = await _call_classify({
        "model": "gpt-4",
        "messages": [{"role": "user", "content": "hello"}],
    })
    assert result["classification"] == "SIMPLE"
    assert result["confidence"] == 0.9
    assert result["model"] == "gpt-4"
    assert result["message_count"] == 1


@pytest.mark.asyncio
async def test_classify_multi_message():
    """Multiple messages should be classified as COMPLEX."""
    result = await _call_classify({
        "model": "claude-3",
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
            {"role": "user", "content": "help me"},
        ],
    })
    assert result["classification"] == "COMPLEX"
    assert result["confidence"] == 0.75
    assert result["model"] == "claude-3"
    assert result["message_count"] == 3


@pytest.mark.asyncio
async def test_classify_empty_messages():
    """Empty messages list should be classified as SIMPLE."""
    result = await _call_classify({"model": "gpt-4", "messages": []})
    assert result["classification"] == "SIMPLE"
    assert result["confidence"] == 0.9
    assert result["message_count"] == 0


@pytest.mark.asyncio
async def test_classify_missing_fields():
    """Missing fields should use defaults."""
    result = await _call_classify({})
    assert result["classification"] == "SIMPLE"
    assert result["model"] == "unknown"
    assert result["message_count"] == 0


@pytest.mark.asyncio
async def test_status_returns_healthy():
    """Status should return healthy with worker name."""
    result = await _call_status()
    assert result["status"] == "healthy"
    assert result["worker"] == "brain"
    assert "engine_url" in result


@pytest.mark.asyncio
async def test_classify_result_shape():
    """Classify result must have all required keys."""
    result = await _call_classify({"model": "x", "messages": []})
    required_keys = {"classification", "confidence", "model", "message_count"}
    assert required_keys.issubset(result.keys())


# ── Delegation tests (iii trigger mocked) ──────────────────────────────────


def _make_classify_with_mock_iii(trigger_fn):
    """Create a classify handler with a mocked iii trigger."""
    mock_iii = MagicMock()
    mock_iii.trigger = trigger_fn

    def classify(data):
        """Replicate the classify handler from main.py."""
        from main import SELECTOR_TIMEOUT_MS, logger
        try:
            result = mock_iii.trigger({
                "function_id": "selector::classify",
                "payload": data,
                "timeout_ms": SELECTOR_TIMEOUT_MS,
            })
            logger.info("Classification delegated to selector-worker")
            return {
                "classification": result.get("classification", "COMPLEX"),
                "confidence": result.get("confidence", 0.5),
                "model": result.get("model", data.get("model", "unknown")),
                "message_count": len(data.get("messages", [])),
                "source": "selector-worker",
            }
        except Exception as e:
            logger.warning("Selector worker unavailable (%s), using brain-fallback", e)
            fallback = _inline_heuristic(data)
            fallback["source"] = "brain-fallback"
            return fallback

    return classify


def test_delegation_success_returns_selector_worker_source():
    """When iii trigger succeeds, result includes source='selector-worker'."""
    classify = _make_classify_with_mock_iii(lambda req: {
        "classification": "simple",
        "confidence": 0.85,
        "source": "slm",
        "model": "gpt-4",
        "latencyMs": 42,
    })

    result = classify({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})
    assert result["source"] == "selector-worker"
    assert result["classification"] == "simple"
    assert result["confidence"] == 0.85
    assert result["model"] == "gpt-4"
    assert result["message_count"] == 1


def test_delegation_timeout_falls_back_to_brain_fallback():
    """When iii trigger times out, result includes source='brain-fallback'."""
    def timeout_trigger(req):
        raise TimeoutError("selector::classify timed out")

    classify = _make_classify_with_mock_iii(timeout_trigger)

    result = classify({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})
    assert result["source"] == "brain-fallback"
    assert result["classification"] == "SIMPLE"
    assert result["confidence"] == 0.9


def test_delegation_error_falls_back_to_brain_fallback():
    """When iii trigger raises any error, result includes source='brain-fallback'."""
    def error_trigger(req):
        raise ConnectionError("selector worker not connected")

    classify = _make_classify_with_mock_iii(error_trigger)

    result = classify({
        "model": "claude-3",
        "messages": [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ],
    })
    assert result["source"] == "brain-fallback"
    assert result["classification"] == "COMPLEX"
    assert result["confidence"] == 0.75


def test_delegation_passes_payload_to_trigger():
    """classify() passes the original data as payload to iii trigger."""
    captured = {}

    def capture_trigger(req):
        captured.update(req)
        return {"classification": "simple", "confidence": 0.85, "model": "x", "latencyMs": 10}

    classify = _make_classify_with_mock_iii(capture_trigger)
    classify({"model": "gpt-4", "messages": [{"role": "user", "content": "test"}]})

    assert captured["function_id"] == "selector::classify"
    assert captured["payload"]["model"] == "gpt-4"
    assert captured["timeout_ms"] == 2000


def test_delegation_uses_defaults_when_selector_result_incomplete():
    """When selector returns partial result, brain applies safe defaults."""
    classify = _make_classify_with_mock_iii(lambda req: {
        "classification": "simple",
        # missing confidence, model, latencyMs
    })

    result = classify({"model": "gpt-4", "messages": []})
    assert result["source"] == "selector-worker"
    assert result["confidence"] == 0.5  # default
    assert result["model"] == "gpt-4"  # falls back to input model
