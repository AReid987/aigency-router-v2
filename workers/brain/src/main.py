"""Brain worker — AI classification and routing decisions for iii engine."""

import logging
import os
import signal
import sys

from iii import register_worker, InitOptions

logging.basicConfig(
    level=logging.INFO,
    format="[brain] %(message)s",
)
logger = logging.getLogger("brain")

ENGINE_URL = os.environ.get("III_URL", "ws://127.0.0.1:49134")


def create_brain_worker(url: str = ENGINE_URL):
    """Create and register the brain worker with the iii engine."""
    iii = register_worker(url, InitOptions(worker_name="brain"))

    def classify(data):
        """Classify a request as SIMPLE or COMPLEX based on model/messages."""
        model = data.get("model", "unknown")
        messages = data.get("messages", [])
        # Simple heuristic: single message = SIMPLE, multi-message = COMPLEX
        classification = "SIMPLE" if len(messages) <= 1 else "COMPLEX"
        confidence = 0.9 if classification == "SIMPLE" else 0.75
        return {
            "classification": classification,
            "confidence": confidence,
            "model": model,
            "message_count": len(messages),
        }

    def status(data=None):
        """Return brain worker health status."""
        return {
            "status": "healthy",
            "worker": "brain",
            "engine_url": ENGINE_URL,
        }

    iii.register_function("brain::classify", classify)
    iii.register_function("brain::status", status)

    return iii


def main():
    """Start the brain worker and keep it running."""
    logger.info("Starting brain worker, connecting to %s", ENGINE_URL)
    iii = create_brain_worker(ENGINE_URL)
    logger.info("Brain worker registered — brain::classify and brain::status ready")

    # Wait for shutdown signal
    def _signal_handler(sig, frame):
        logger.info("Shutdown signal received (%s)", sig)
        iii.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)

    # Block main thread
    signal.pause()


if __name__ == "__main__":
    main()
