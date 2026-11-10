"""Google Gemini LLM streaming — uses Google AI Studio (free tier, 15 RPM).

Includes:
  - stream_answer: streaming chat completions with automatic retry on 429
  - complete_text: buffered completions
  - classify_query: fast single-token classification (personal vs general)
  - analyze_document_with_file: multimodal document analysis (images/PDFs)
"""

from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path
from typing import AsyncGenerator

import httpx

GOOGLE_API_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_FALLBACK_MODEL = "gemini-3.5-flash-lite"
_quota_exhausted_models: set[str] = set()

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


def _get_candidate_models() -> list[str]:
    """Return usable models in priority order, skipping exhausted daily quotas."""
    configured_fallbacks = os.getenv("GEMINI_FALLBACK_MODELS", DEFAULT_FALLBACK_MODEL)
    candidates = [_get_model(), *(m.strip() for m in configured_fallbacks.split(","))]
    unique = []
    for model in candidates:
        if model and model not in unique and model not in _quota_exhausted_models:
            unique.append(model)
    return unique


def _quota_message(body: bytes) -> str:
    """Preserve Gemini's useful quota reason and reset time for the UI."""
    text = body.decode(errors="replace")
    try:
        return str(json.loads(text).get("error", {}).get("message", text)).strip()
    except json.JSONDecodeError:
        return text.strip()


def _build_gemini_contents(messages: list[dict]) -> tuple[str | None, list[dict]]:
    """Convert OpenAI-style messages to Gemini format.
    Returns (system_instruction, contents)."""
    system_instruction = None
    gemini_contents = []

    for msg in messages:
        if msg["role"] == "system":
            system_instruction = msg["content"] if isinstance(msg["content"], str) else ""
        elif msg["role"] == "user":
            content = msg["content"]
            if isinstance(content, str):
                gemini_contents.append({
                    "role": "user",
                    "parts": [{"text": content}]
                })
            elif isinstance(content, list):
                # Multimodal: list of parts (text, images, files)
                parts = []
                for part in content:
                    if isinstance(part, dict):
                        if part.get("type") == "text":
                            parts.append({"text": part["text"]})
                        elif part.get("type") == "image_data":
                            parts.append({
                                "inline_data": {
                                    "mime_type": part["mime_type"],
                                    "data": part["data"],  # base64
                                }
                            })
                    elif isinstance(part, str):
                        parts.append({"text": part})
                gemini_contents.append({"role": "user", "parts": parts})
        elif msg["role"] == "assistant":
            gemini_contents.append({
                "role": "model",
                "parts": [{"text": msg["content"]}]
            })

    return system_instruction, gemini_contents


async def stream_answer(messages: list[dict]) -> AsyncGenerator[str, None]:
    """Stream chat completion deltas from Google Gemini API.

    A 429 is returned immediately instead of retrying. Retrying several times
    within the same one-minute quota window consumes additional requests and
    makes a single user message look like many requests.
    """
    api_key = _get_api_key()
    system_instruction, gemini_contents = _build_gemini_contents(messages)

    body: dict = {
        "contents": gemini_contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 8192,
        },
    }

    if system_instruction:
        body["system_instruction"] = {"parts": [{"text": system_instruction}]}

    last_quota_error = ""
    for model in _get_candidate_models():
        url = f"{GOOGLE_API_URL}/models/{model}:streamGenerateContent?alt=sse&key={api_key}"
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                url,
                headers={"Content-Type": "application/json"},
                json=body,
            ) as response:
                if response.status_code == 429:
                    _quota_exhausted_models.add(model)
                    last_quota_error = _quota_message(await response.aread())
                    print(f"[llm] {model} quota exhausted; trying configured fallback.")
                    continue
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
                return

    if not last_quota_error:
        raise RuntimeError("No Gemini model is configured for this request.")
    reset = re.search(r"Please retry in ([^.]+)", last_quota_error)
    retry_hint = f" Retry in {reset.group(1)}." if reset else ""
    raise RuntimeError(
        "All configured Gemini models have reached their provider quota."
        + retry_hint
        + " Add billing or configure another model/API key."
    )


async def complete_text(messages: list[dict]) -> str:
    """Buffered completion built on the streaming path."""
    text = ""
    async for delta in stream_answer(messages):
        text += delta
    return text.strip()


async def classify_query(question: str, history: list[dict] | None = None) -> str:
    """Classify locally so a chat turn requires only its answer-generation call.

    Classification is presentation/routing metadata, so using a second Gemini
    request for it is wasteful on the free RPM quota.
    """
    q_lower = question.lower()

    # ── Document intelligence intents (check before generic document_generate) ──

    restore_indicators = (
        "restore", "recover", "fix this document", "old document",
        "faded", "blurred", "blurry", "unclear", "unreadable",
        "damaged document", "poor quality", "improve scan",
        "clean up", "scanned document", "old scan", "illegible",
    )
    if any(indicator in q_lower for indicator in restore_indicators):
        return "document_restore"

    enhance_indicators = (
        "enhance", "improve", "rewrite", "polish", "refine",
        "make it better", "make it professional", "make it formal",
        "upgrade document", "improve this document", "enhance this",
        "reformat", "restructure", "improve quality", "better version",
    )
    if any(indicator in q_lower for indicator in enhance_indicators):
        return "document_enhance"

    authenticity_indicators = (
        "authentic", "genuine", "fake", "forged", "forgery",
        "tampered", "suspicious", "verify document", "check authenticity",
        "is this real", "is this genuine", "is this fake",
        "document fraud", "verify this", "check if",
    )
    if any(indicator in q_lower for indicator in authenticity_indicators):
        return "document_authenticity"

    compare_indicators = (
        "compare", "difference", "differences between",
        "contrast", "what changed", "changes between",
        "side by side", "compare these", "compare document",
        "diff ", "versus", " vs ",
    )
    if any(indicator in q_lower for indicator in compare_indicators):
        return "document_compare"

    summarize_indicators = (
        "summarize", "summarise", "summary", "key points",
        "main points", "brief overview", "what does this say",
        "tldr", "tl;dr", "gist of", "outline of",
        "extract key", "important points",
    )
    if any(indicator in q_lower for indicator in summarize_indicators):
        return "document_summarize"

    # ── Existing intents ──

    document_indicators = (
        "draft ", "generate ", "create ", "write a ", "prepare ",
        "legal notice", "affidavit", "agreement", "application", "petition",
        "complaint letter", "rti request",
    )
    if any(indicator in q_lower for indicator in document_indicators):
        return "document_generate"

    personal_indicators = (
        "my ", "i am", "i was", "me ", "i have", "i need", "i want",
        "i got", "i received", "help me", "what should i", "what can i",
        "please help", "i filed", "against me", "my case", "my landlord",
        "my employer", "my boss",
    )
    return "personal_case" if any(indicator in q_lower for indicator in personal_indicators) else "general_legal"


async def analyze_document_with_file(
    file_path: str,
    mime_type: str,
    language: str = "en",
) -> dict:
    """Analyze a legal document using Gemini's multimodal capabilities.

    Accepts images and PDFs. Returns structured analysis dict.
    """
    api_key = _get_api_key()
    model = _get_model()

    # Read and base64-encode the file
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Document not found: {file_path}")

    with open(path, "rb") as f:
        file_bytes = f.read()
    file_b64 = base64.b64encode(file_bytes).decode("utf-8")

    from prompts import language_label
    lang = language_label(language)

    prompt_text = "\n".join([
        "Read this Indian legal document carefully and thoroughly.",
        "Return ONLY a valid JSON object with these keys:",
        '"documentType" (string — e.g. "Legal Notice", "Court Order", "FIR", "Agreement"),',
        '"summary" (string — 4-8 detailed plain-language sentences explaining what this document is about, who it involves, and what it means),',
        '"parties" (array of strings — all people, companies, authorities mentioned),',
        '"obligations" (array of strings — what the document requires or orders),',
        '"dates" (array of strings — all dates, deadlines, limitation periods mentioned),',
        '"risks" (array of strings — risks, penalties, consequences mentioned),',
        '"nextSteps" (array of strings — practical actions the recipient should take),',
        '"quality" (string — describe the scan/image legibility),',
        '"cleanedText" (string — a faithful, well-formatted typed transcription of the ENTIRE document contents)',
        f'Write every value except "cleanedText" in {lang}. Keep "cleanedText" in the document\'s own language.',
        "If something is not legible, say so instead of guessing.",
    ])

    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": prompt_text},
                {
                    "inline_data": {
                        "mime_type": mime_type,
                        "data": file_b64,
                    }
                },
            ],
        }],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 8192,
        },
    }

    url = f"{GOOGLE_API_URL}/models/{model}:generateContent?key={api_key}"

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            url,
            headers={"Content-Type": "application/json"},
            json=body,
        )

    if response.status_code >= 400:
        raise RuntimeError(f"Gemini API error {response.status_code}: {response.text[:300]}")

    data = response.json()
    raw_text = ""
    candidates = data.get("candidates", [])
    if candidates:
        parts = candidates[0].get("content", {}).get("parts", [])
        for part in parts:
            if "text" in part:
                raw_text += part["text"]

    # Parse the JSON from the response
    return _parse_analysis_json(raw_text)


def _parse_analysis_json(raw: str) -> dict:
    """Extract a JSON object from LLM output, handling markdown fences."""
    import re
    # Try to find JSON in markdown code fences
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    candidate = (fenced.group(1) if fenced else raw).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end == -1:
        return {
            "documentType": "Legal document",
            "summary": raw[:1200],
            "parties": [],
            "obligations": [],
            "dates": [],
            "risks": [],
            "nextSteps": [],
            "quality": "",
            "cleanedText": None,
        }
    try:
        parsed = json.loads(candidate[start:end + 1])
        def str_list(val):
            if not isinstance(val, list):
                return []
            return [str(v) for v in val if v][:12]

        return {
            "documentType": str(parsed.get("documentType", "Legal document")),
            "summary": str(parsed.get("summary", raw[:1200])),
            "parties": str_list(parsed.get("parties")),
            "obligations": str_list(parsed.get("obligations")),
            "dates": str_list(parsed.get("dates")),
            "risks": str_list(parsed.get("risks")),
            "nextSteps": str_list(parsed.get("nextSteps")),
            "quality": str(parsed.get("quality", "")),
            "cleanedText": str(parsed.get("cleanedText", "")) or None,
        }
    except (json.JSONDecodeError, ValueError):
        return {
            "documentType": "Legal document",
            "summary": raw[:1200],
            "parties": [],
            "obligations": [],
            "dates": [],
            "risks": [],
            "nextSteps": [],
            "quality": "",
            "cleanedText": None,
        }
