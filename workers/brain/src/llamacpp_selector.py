"""LLAMACppSelector — embedded SLM classifier using llama-cpp-python.

Loads a local GGUF model in-process; no external daemon. Model is loaded
lazily on first classify call and cached for subsequent calls.

Default model: ./models/bonsai-1.7b-q4km.gguf
Override path via LLAMACPP_MODEL_PATH env var.
"""

import json
import logging
import os
import threading
from typing import Any, Optional

from selector import Selector

logger = logging.getLogger("brain.llamacpp")

DEFAULT_MODEL_PATH = "./models/bonsai-1.7b-q4km.gguf"
DEFAULT_N_CTX = 512
DEFAULT_MAX_TOKENS = 32
DEFAULT_TEMPERATURE = 0.0
DEFAULT_TIMEOUT_S = 5.0

PROMPT_TEMPLATE = (
    "Classify this LLM request as SIMPLE (single-turn, short, well-defined) "
    "or COMPLEX (multi-turn, ambiguous, requires reasoning). "
    "Reply with JSON only: {{\"classification\": \"SIMPLE|COMPLEX\", \"confidence\": 0.0-1.0}}. "
    "Model: {model}. Messages: {n}."
)


class LLAMACppSelector(Selector):
    """Embedded llama-cpp-python classifier. Robust to model load + generation errors."""

    def __init__(
        self,
        model_path: Optional[str] = None,
        n_ctx: int = DEFAULT_N_CTX,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = DEFAULT_TEMPERATURE,
        timeout_s: float = DEFAULT_TIMEOUT_S,
    ):
        self.model_path = model_path or os.environ.get("LLAMACPP_MODEL_PATH", DEFAULT_MODEL_PATH)
        self.n_ctx = n_ctx
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.timeout_s = timeout_s
        self._model = None
        self._load_lock = threading.Lock()
        _basename = os.path.basename(self.model_path)
        try:
            _size = os.path.getsize(self.model_path)
            logger.info("Model path: %s (%.0f MB)", _basename, _size / 1e6)
        except OSError:
            logger.info("Model path: %s (file not found)", _basename)

    def _load_model(self):
        """Lazy-load the model on first call. Cached after first load."""
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is not None:
                return self._model
            try:
                from llama_cpp import Llama  # type: ignore
            except Exception as e:
                logger.warning("llama_cpp import failed (%s)", e)
                raise RuntimeError(f"llama_cpp import failed: {e}")
            if not os.path.exists(self.model_path):
                raise FileNotFoundError(f"Model file not found: {self.model_path}")
            logger.info("Loading llama-cpp model from %s", self.model_path)
            self._model = Llama(
                model_path=self.model_path,
                n_ctx=self.n_ctx,
                verbose=False,
            )
            return self._model

    def classify(self, data: dict[str, Any]) -> dict[str, Any]:
        model = data.get("model", "unknown")
        messages = data.get("messages", [])
        message_count = len(messages)
        prompt = PROMPT_TEMPLATE.format(model=model, n=message_count)
        try:
            llama = self._load_model()
        except (FileNotFoundError, RuntimeError) as e:
            logger.warning("Model load failed (%s), returning UNKNOWN", e)
            return {
                "classification": "UNKNOWN",
                "confidence": 0.0,
                "model": model,
                "message_count": message_count,
                "source": "llamacpp-error",
            }

        try:
            output = llama(
                prompt,
                max_tokens=self.max_tokens,
                temperature=self.temperature,
                stop=["\n"],
            )
            text = output["choices"][0]["text"].strip()
        except Exception as e:
            logger.warning("Generation failed (%s), returning UNKNOWN", e)
            return {
                "classification": "UNKNOWN",
                "confidence": 0.0,
                "model": model,
                "message_count": message_count,
                "source": "llamacpp-error",
            }

        try:
            parsed = json.loads(text)
            return {
                "classification": str(parsed.get("classification", "UNKNOWN")),
                "confidence": float(parsed.get("confidence", 0.0)),
                "model": model,
                "message_count": message_count,
                "source": "llamacpp",
            }
        except (json.JSONDecodeError, ValueError, TypeError) as e:
            logger.warning("Invalid JSON from model (%s), returning UNKNOWN", e)
            return {
                "classification": "UNKNOWN",
                "confidence": 0.0,
                "model": model,
                "message_count": message_count,
                "source": "llamacpp-parse-error",
            }
