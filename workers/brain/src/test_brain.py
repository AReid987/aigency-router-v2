"""Tests for the brain worker handlers and selectors."""

import os
import pytest
from unittest.mock import MagicMock, patch

from heuristic_selector import HeuristicSelector
from selector import Selector


# ── HeuristicSelector tests ───────────────────────────────────────────────


def test_heuristic_single_message():
    """Single message should be classified as SIMPLE with high confidence."""
    sel = HeuristicSelector()
    result = sel.classify({"model": "gpt-4", "messages": [{"role": "user", "content": "hello"}]})
    assert result["classification"] == "SIMPLE"
    assert result["confidence"] == 0.9
    assert result["model"] == "gpt-4"
    assert result["message_count"] == 1
    assert result["source"] == "heuristic"


def test_heuristic_multi_message():
    """Multi-message should be classified as COMPLEX."""
    sel = HeuristicSelector()
    result = sel.classify({
        "model": "claude-3",
        "messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}],
    })
    assert result["classification"] == "COMPLEX"
    assert result["confidence"] == 0.75
    assert result["message_count"] == 2
    assert result["source"] == "heuristic"


def test_heuristic_missing_messages():
    """Missing messages key should default to empty list."""
    sel = HeuristicSelector()
    result = sel.classify({"model": "test"})
    assert result["classification"] == "SIMPLE"
    assert result["message_count"] == 0


def test_heuristic_is_selector():
    """HeuristicSelector must inherit from Selector ABC."""
    assert issubclass(HeuristicSelector, Selector)


# ── Build-selector dispatch tests ──────────────────────────────────────────


def test_build_selector_heuristic_default(monkeypatch):
    """Default BRAIN_SELECTOR returns HeuristicSelector."""
    monkeypatch.delenv("BRAIN_SELECTOR", raising=False)
    from main import build_selector
    sel = build_selector("heuristic")
    assert isinstance(sel, HeuristicSelector)


def test_build_selector_unknown_falls_back(monkeypatch):
    """Unknown selector kind falls back to HeuristicSelector."""
    monkeypatch.delenv("BRAIN_SELECTOR", raising=False)
    from main import build_selector
    sel = build_selector("nonsense")
    assert isinstance(sel, HeuristicSelector)


# ── LLAMACppSelector tests (mocked llama_cpp) ───────────────────────────


def test_llamacpp_subclasses_selector():
    from llamacpp_selector import LLAMACppSelector
    assert issubclass(LLAMACppSelector, Selector)


def test_llamacpp_success_response(monkeypatch, tmp_path):
    """Llama model returns valid JSON → source='llamacpp'."""
    import sys
    import types
    from llamacpp_selector import LLAMACppSelector

    class FakeLlama:
        def __init__(self, *args, **kwargs):
            pass

        def __call__(self, prompt, **kwargs):
            return {"choices": [{"text": '{"classification": "COMPLEX", "confidence": 0.82}'}]}

    fake_mod = types.ModuleType("llama_cpp")
    fake_mod.Llama = FakeLlama
    monkeypatch.setitem(sys.modules, "llama_cpp", fake_mod)

    fake_model = tmp_path / "model.gguf"
    fake_model.write_bytes(b"GGUF\x03\x00\x00\x00")
    sel = LLAMACppSelector(model_path=str(fake_model), max_tokens=32)
    result = sel.classify({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]})
    assert result["classification"] == "COMPLEX"
    assert result["confidence"] == 0.82
    assert result["model"] == "gpt-4"
    assert result["message_count"] == 2
    assert result["source"] == "llamacpp"


def test_llamacpp_model_file_missing(monkeypatch):
    """Model file not found → source='llamacpp-error'."""
    from llamacpp_selector import LLAMACppSelector
    sel = LLAMACppSelector(model_path="/nonexistent/model.gguf")
    result = sel.classify({"model": "gpt-4", "messages": []})
    assert result["classification"] == "UNKNOWN"
    assert result["confidence"] == 0.0
    assert result["source"] == "llamacpp-error"


def test_llamacpp_invalid_json_response(monkeypatch, tmp_path):
    """Llama returns non-JSON text → source='llamacpp-parse-error'."""
    import sys
    import types
    from llamacpp_selector import LLAMACppSelector

    class FakeLlama:
        def __init__(self, *args, **kwargs):
            pass

        def __call__(self, prompt, **kwargs):
            return {"choices": [{"text": "not-valid-json"}]}

    fake_mod = types.ModuleType("llama_cpp")
    fake_mod.Llama = FakeLlama
    monkeypatch.setitem(sys.modules, "llama_cpp", fake_mod)

    fake_model = tmp_path / "model.gguf"
    fake_model.write_bytes(b"GGUF\x03\x00\x00\x00")
    sel = LLAMACppSelector(model_path=str(fake_model))
    result = sel.classify({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})
    assert result["source"] == "llamacpp-parse-error"
    assert result["message_count"] == 1


def test_llamacpp_generation_exception(monkeypatch, tmp_path):
    """Llama raises during generation → source='llamacpp-error'."""
    import sys
    import types
    from llamacpp_selector import LLAMACppSelector

    class FakeLlama:
        def __init__(self, *args, **kwargs):
            pass

        def __call__(self, prompt, **kwargs):
            raise RuntimeError("model out of memory")

    fake_mod = types.ModuleType("llama_cpp")
    fake_mod.Llama = FakeLlama
    monkeypatch.setitem(sys.modules, "llama_cpp", fake_mod)

    fake_model = tmp_path / "model.gguf"
    fake_model.write_bytes(b"GGUF\x03\x00\x00\x00")
    sel = LLAMACppSelector(model_path=str(fake_model))
    result = sel.classify({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]})
    assert result["source"] == "llamacpp-error"
    assert result["classification"] == "UNKNOWN"


def test_build_selector_slm_dispatches(monkeypatch):
    """BRAIN_SELECTOR=slm selects LLAMACppSelector when importable."""
    monkeypatch.setenv("BRAIN_SELECTOR", "slm")
    from main import build_selector
    from llamacpp_selector import LLAMACppSelector
    sel = build_selector("slm")
    assert isinstance(sel, LLAMACppSelector)
