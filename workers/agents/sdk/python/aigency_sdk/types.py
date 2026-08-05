"""OpenAI-compatible typed dataclasses for the Aigency API."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Generator, Literal


Role = Literal["user", "assistant", "system"]


@dataclass
class ChatCompletionMessage:
    role: Role = "assistant"
    content: str = ""


@dataclass
class Choice:
    index: int = 0
    message: ChatCompletionMessage = field(default_factory=ChatCompletionMessage)
    finish_reason: str = "stop"


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


@dataclass
class ChatCompletionRequest:
    model: str = ""
    messages: list[ChatCompletionMessage] = field(default_factory=list)
    stream: bool = False
    max_tokens: int | None = None
    temperature: float | None = None


@dataclass
class ChoiceDelta:
    index: int = 0
    delta: ChatCompletionMessage = field(default_factory=ChatCompletionMessage)
    finish_reason: str | None = None


@dataclass
class ChatCompletionResponse:
    id: str = ""
    object: str = "chat.completion"
    created: int = 0
    model: str = ""
    choices: list[Choice] = field(default_factory=list)
    usage: Usage | None = None

    @staticmethod
    def from_dict(data: dict) -> ChatCompletionResponse:
        choices = []
        for c in data.get("choices", []):
            msg_data = c.get("message", {})
            message = ChatCompletionMessage(
                role=msg_data.get("role", "assistant"),
                content=msg_data.get("content", ""),
            )
            choices.append(Choice(
                index=c.get("index", 0),
                message=message,
                finish_reason=c.get("finish_reason", "stop"),
            ))
        usage_data = data.get("usage")
        usage = None
        if usage_data:
            usage = Usage(
                prompt_tokens=usage_data.get("prompt_tokens", 0),
                completion_tokens=usage_data.get("completion_tokens", 0),
                total_tokens=usage_data.get("total_tokens", 0),
            )
        return ChatCompletionResponse(
            id=data.get("id", ""),
            object=data.get("object", "chat.completion"),
            created=data.get("created", int(time.time())),
            model=data.get("model", ""),
            choices=choices,
            usage=usage,
        )


@dataclass
class ChatCompletionChunk:
    id: str = ""
    object: str = "chat.completion.chunk"
    created: int = 0
    model: str = ""
    choices: list[ChoiceDelta] = field(default_factory=list)

    @staticmethod
    def from_dict(data: dict) -> ChatCompletionChunk:
        choices = []
        for c in data.get("choices", []):
            delta_data = c.get("delta", {})
            delta = ChatCompletionMessage(
                role=delta_data.get("role", "assistant"),
                content=delta_data.get("content", ""),
            )
            choices.append(ChoiceDelta(
                index=c.get("index", 0),
                delta=delta,
                finish_reason=c.get("finish_reason"),
            ))
        return ChatCompletionChunk(
            id=data.get("id", ""),
            object=data.get("object", "chat.completion.chunk"),
            created=data.get("created", int(time.time())),
            model=data.get("model", ""),
            choices=choices,
        )
