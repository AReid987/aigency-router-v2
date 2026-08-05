# Aigency Router + aider Integration

[aider](https://aider.chat/) is an AI pair programming tool. This guide shows
how to point aider at the Aigency Router gateway so all LLM requests are
routed, failover-protected, and monitored by Aigency.

## Prerequisites

- Python 3.10+
- `pip install aigency-sdk` (or install from source in this repo)
- A running Aigency Router gateway instance

## Quick Start

### 1. Install the Python SDK

```bash
pip install aigency-sdk
```

Or install from the local source:

```bash
cd workers/agents/sdk/python
pip install -e .
```

### 2. Set environment variables

```bash
export AIGENCY_BASE_URL="http://localhost:8787/v1"
export AIGENCY_API_KEY="sk-your-key"          # optional — omit if auth is disabled
```

### 3. Run aider with the Aigency Router

```bash
aider --openai-api-base "$AIGENCY_BASE_URL" --openai-api-key "$AIGENCY_API_KEY"
```

aider will now send all chat completion requests through the Aigency Router.
The router handles:

- **Provider failover**: if one provider fails, the next is tried automatically
- **JSON healing**: malformed provider responses are repaired transparently
- **Quota monitoring**: track usage across providers (see `get_quota_status`)
- **Streaming**: SSE streaming works out of the box

### 4. Verify it's working

```bash
aider --openai-api-base "$AIGENCY_BASE_URL" --openai-api-key "$AIGENCY_API_KEY" \
  --message "What Python version are we running?"
```

aider should respond with the answer, routed through Aigency.

## Configuration

Copy the example config file:

```bash
cp config.example.yaml ~/.aigency-aider.yaml
```

Then edit with your base URL and API key, and run:

```bash
aider --config ~/.aigency-aider.yaml
```

## Using the SDK Directly

```python
from aigency_sdk import AigencyClient, ChatCompletionRequest, ChatCompletionMessage

client = AigencyClient(
    base_url="http://localhost:8787",
    api_key="sk-your-key",
)

request = ChatCompletionRequest(
    model="gpt-4",
    messages=[ChatCompletionMessage(role="user", content="Hello!")],
)

response = client.chat.completions.create(request)
print(response.choices[0].message.content)
```

## Monitoring

Check your quota and usage status:

```python
from aigency_sdk import get_quota_status

status = get_quota_status("http://localhost:8787")
print(status["providers"])
```
