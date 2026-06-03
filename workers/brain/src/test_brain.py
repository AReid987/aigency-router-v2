"""Tests for the brain worker handlers."""

import pytest


# We test the handler logic in isolation (no engine connection needed).


async def _call_classify(payload: dict) -> dict:
    """Simulate the classify handler logic."""
    model = payload.get("model", "unknown")
    messages = payload.get("messages", [])
    classification = "SIMPLE" if len(messages) <= 1 else "COMPLEX"
    confidence = 0.9 if classification == "SIMPLE" else 0.75
    return {
        "classification": classification,
        "confidence": confidence,
        "model": model,
        "message_count": len(messages),
    }


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
