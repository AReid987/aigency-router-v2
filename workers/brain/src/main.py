"""Brain worker — AI classification and routing decisions for iii engine."""

import logging
import os
import signal
import sys

from iii import register_worker, InitOptions

from selector import Selector
from heuristic_selector import HeuristicSelector

logging.basicConfig(
    level=logging.INFO,
    format="[brain] %(message)s",
)
logger = logging.getLogger("brain")

ENGINE_URL = os.environ.get("III_URL", "ws://127.0.0.1:49134")
SELECTOR_KIND = os.environ.get("BRAIN_SELECTOR", "heuristic").lower()


def build_selector(kind: str) -> Selector:
    """Construct the configured selector. Falls back to HeuristicSelector on unknown kind."""
    if kind == "slm":
        try:
            from llamacpp_selector import LLAMACppSelector
            logger.info("Selector: LLAMACppSelector (embedded llama-cpp-python)")
            return LLAMACppSelector()
        except Exception as e:
            logger.warning("LLAMACppSelector unavailable (%s), falling back to HeuristicSelector", e)
            return HeuristicSelector()
    logger.info("Selector: HeuristicSelector (default)")
    return HeuristicSelector()


def create_brain_worker(url: str = ENGINE_URL, selector: Selector = None):
    """Create and register the brain worker with the iii engine."""
    if selector is None:
        selector = build_selector(SELECTOR_KIND)
    iii = register_worker(url, InitOptions(worker_name="brain"))

    def classify(data):
        """Classify a request using the configured local selector."""
        try:
            return selector.classify(data)
        except Exception as e:
            logger.warning("Selector raised (%s), using fallback", e)
            fallback = HeuristicSelector().classify(data)
            fallback["source"] = "brain-fallback"
            return fallback

    def status(data=None):
        """Return brain worker health status."""
        return {
            "status": "healthy",
            "worker": "brain",
            "engine_url": ENGINE_URL,
            "selector": SELECTOR_KIND,
        }

    iii.register_function("brain::classify", classify)
    iii.register_function("brain::status", status)

    return iii


def main():
    """Start the brain worker and keep it running."""
    logger.info("Starting brain worker, connecting to %s", ENGINE_URL)
    iii = create_brain_worker(ENGINE_URL)
    logger.info("Brain worker registered — brain::classify and brain::status ready")

    def _signal_handler(sig, frame):
        logger.info("Shutdown signal received (%s)", sig)
        iii.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)
    signal.pause()


if __name__ == "__main__":
    main()
