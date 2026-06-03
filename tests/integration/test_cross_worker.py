"""Cross-worker integration tests — Python side.

Verifies that a Python worker can call:
  1. gateway::echo    (Python → TS)
  2. brain::classify  (Python → Python)

Prerequisites: iii engine + all workers must be running.
Run: python -m pytest test_cross_worker.py -v
"""

import os
import signal
import sys

import pytest

# Add brain worker to path so we can import iii SDK
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'workers', 'brain'))

from iii import register_worker, InitOptions

ENGINE_URL = os.environ.get('III_URL', 'ws://127.0.0.1:49134')


@pytest.fixture(scope='module')
def worker():
    """Create a test Python worker connected to the engine."""
    iii = register_worker(ENGINE_URL, InitOptions(worker_name='integration-test-py'))
    yield iii
    iii.shutdown()


def test_gateway_echo(worker):
    """Python → TS: Call gateway::echo and verify echo response."""
    result = worker.trigger({
        'function_id': 'gateway::echo',
        'payload': {'message': 'py-integration-ping'},
    })

    assert result is not None, 'result should not be None'
    assert result['echo'] == 'py-integration-ping'
    assert result['worker'] == 'gateway'
    assert 'timestamp' in result


def test_brain_classify(worker):
    """Python → Python: Call brain::classify and verify classification."""
    result = worker.trigger({
        'function_id': 'brain::classify',
        'payload': {
            'model': 'claude-3',
            'messages': [
                {'role': 'user', 'content': 'hello'},
                {'role': 'assistant', 'content': 'hi'},
            ],
        },
    })

    assert result is not None, 'result should not be None'
    assert result['classification'] == 'COMPLEX'
    assert result['model'] == 'claude-3'
    assert result['message_count'] == 2
    assert isinstance(result['confidence'], float)
    assert result['confidence'] > 0


def test_brain_status(worker):
    """Python → Python: Call brain::status and verify healthy response."""
    result = worker.trigger({
        'function_id': 'brain::status',
        'payload': {},
    })

    assert result is not None, 'result should not be None'
    assert result['status'] == 'healthy'
    assert result['worker'] == 'brain'


def test_gateway_status(worker):
    """Python → TS: Call gateway::status and verify healthy response."""
    result = worker.trigger({
        'function_id': 'gateway::status',
        'payload': {},
    })

    assert result is not None, 'result should not be None'
    assert result['status'] == 'healthy'
    assert result['worker'] == 'gateway'
