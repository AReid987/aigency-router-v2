"""Selector interface for brain worker classification.

Pluggable selector pattern: HeuristicSelector (default, inline) or SLMSelector (Ollama-backed).
Selected via BRAIN_SELECTOR env var at brain worker startup.
"""

from abc import ABC, abstractmethod
from typing import Any


class Selector(ABC):
    """Abstract base class for brain worker classifiers.

    Implementations classify incoming requests and return a uniform dict:
    {
        "classification": str,    # "SIMPLE" | "COMPLEX" | "UNKNOWN"
        "confidence": float,      # 0.0 - 1.0
        "model": str,             # model name from request
        "message_count": int,     # number of messages
        "source": str,            # selector identifier: "heuristic" | "slm" | "slm-error"
    }
    """

    @abstractmethod
    def classify(self, data: dict[str, Any]) -> dict[str, Any]:
        """Classify an incoming request.

        Args:
            data: dict with keys "model" (str) and "messages" (list).

        Returns:
            dict with classification, confidence, model, message_count, source.
        """
        raise NotImplementedError
