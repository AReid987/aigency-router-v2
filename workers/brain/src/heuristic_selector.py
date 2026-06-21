"""HeuristicSelector — default brain worker classifier.

Inline heuristic: single message = SIMPLE (confidence 0.9), multi-message = COMPLEX (confidence 0.75).
"""

from selector import Selector


class HeuristicSelector(Selector):
    """Deterministic heuristic classifier used when SLMSelector is unavailable."""

    def classify(self, data):
        model = data.get("model", "unknown")
        messages = data.get("messages", [])
        classification = "SIMPLE" if len(messages) <= 1 else "COMPLEX"
        confidence = 0.9 if classification == "SIMPLE" else 0.75
        return {
            "classification": classification,
            "confidence": confidence,
            "model": model,
            "message_count": len(messages),
            "source": "heuristic",
        }
