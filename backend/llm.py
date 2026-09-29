"""Google Gemini LLM streaming — uses Google AI Studio (free tier, 15 RPM)."""

from __future__ import annotations

import json
import os
from typing import AsyncGenerator

import httpx

GOOGLE_API_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-2.5-flash"


def _get_api_key() -> str:
    key = os.getenv("GOOGLE_API_KEY", "").strip()
    if not key or key == "paste-your-google-api-key-here":
        raise RuntimeError(
            "GOOGLE_API_KEY is not configured. "
            "Get a free key from https://aistudio.google.com/apikey "
            "and paste it into backend/.env"
        )
    return key


def _get_model() -> str:
    return os.getenv("GEMINI_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL


async def stream_answer(messages: list[dict]) -> AsyncGenerator[str, None]:
    """Stream chat completion deltas from Google Gemini API."""
    api_key = _get_api_key()
    model = _get_model()

    # Convert OpenAI-style messages to Gemini format
    system_instruction = None
    gemini_contents = []

    for msg in messages:
        if msg["role"] == "system":
            system_instruction = msg["content"]
        elif msg["role"] == "user":
            gemini_contents.append({
                "role": "user",
                "parts": [{"text": msg["content"]}]
            })
        elif msg["role"] == "assistant":
            gemini_contents.append({
                "role": "model",
                "parts": [{"text": msg["content"]}]
            })

    body: dict = {
        "contents": gemini_contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 4096,
        },
    }

    if system_instruction:
        body["system_instruction"] = {"parts": [{"text": system_instruction}]}

    url = f"{GOOGLE_API_URL}/models/{model}:streamGenerateContent?alt=sse&key={api_key}"

    async with httpx.AsyncClient(timeout=60.0) as client:
        async with client.stream(
            "POST",
            url,
            headers={"Content-Type": "application/json"},
            json=body,
        ) as response:
            if response.status_code == 429:
                raise RuntimeError(
                    "Rate limited (free tier allows 15 requests/minute). "
                    "Please wait a moment and try again."
                )
            if response.status_code in (400, 403):
                body_text = await response.aread()
                raise RuntimeError(f"Google API error: {body_text.decode()[:300]}")
            if response.status_code >= 400:
                body_text = await response.aread()
                raise RuntimeError(f"Google API error {response.status_code}: {body_text.decode()[:300]}")

            async for line in response.aiter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]" or not payload:
                    continue
                try:
                    event = json.loads(payload)
                    candidates = event.get("candidates", [])
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        for part in parts:
                            text = part.get("text")
                            if text:
                                yield text
                except (json.JSONDecodeError, IndexError, KeyError):
                    continue


async def complete_text(messages: list[dict]) -> str:
    """Buffered completion built on the streaming path."""
    text = ""
    async for delta in stream_answer(messages):
        text += delta
    return text.strip()
