"""FastAPI backend for the Legal Advisory System.

Provides:
  POST /api/chat          — SSE streaming legal chat (RAG + LLM)
  GET  /api/threads       — list conversation threads
  GET  /api/threads/{id}  — get a thread with all messages
  DELETE /api/threads/{id} — delete a thread

Run with:  python main.py
"""

from __future__ import annotations

import json
import os
import traceback
from typing import AsyncGenerator

from dotenv import load_dotenv

# Load .env BEFORE importing anything that reads env vars
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"), override=True)

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from database import (
    add_message,
    delete_thread,
    get_history,
    get_or_create_thread,
    get_thread,
    get_thread_title,
    init_db,
    list_threads,
    update_thread_title,
)
from llm import complete_text, stream_answer
from models import ChatRequest
from prompts import legal_system_prompt, title_prompt
from retrieval import retrieve_context

# ── App setup ────────────────────────────────────────────────────

app = FastAPI(
    title="Legal Advisory System — Backend",
    description="Python FastAPI backend with ChromaDB + BM25 hybrid RAG for Indian law",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup():
    init_db()
    api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not api_key or api_key == "sk-or-v1-paste-your-key-here":
        print("\n" + "=" * 60)
        print("  WARNING: OPENROUTER_API_KEY is NOT set!")
        print("  Edit backend/.env and paste your key.")
        print("  Get one from: https://openrouter.ai/keys")
        print("=" * 60 + "\n")
    else:
        print(f"[server] OpenRouter API key loaded (ends with ...{api_key[-6:]})")
    print("[server] SQLite database initialized")
    print("[server] Backend ready at http://localhost:" + str(os.getenv("PORT", "8000")))


# ── Chat endpoint (SSE streaming) ────────────────────────────────


def _sse_frame(payload: dict) -> str:
    """Format a single SSE frame exactly as the frontend expects."""
    return f"data: {json.dumps(payload)}\n\n"


@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest):
    """SSE streaming chat — same contract as the original /api/chat."""

    thread_id = get_or_create_thread(
        session_id=req.sessionId,
        thread_id=req.threadId,
        matter_id=req.matterId,
        language=req.language,
    )

    # Save user message
    add_message(thread_id=thread_id, role="user", content=req.message)

    # Get conversation history
    history = get_history(thread_id)

    async def event_generator() -> AsyncGenerator[str, None]:
        answer = ""
        try:
            # Step 1: Retrieve context (RAG)
            print(f"[chat] Retrieving context for: {req.message[:80]}...")
            retrieval = await retrieve_context(req.message)
            print(f"[chat] Retrieved {len(retrieval.citations)} citations, grounding={retrieval.grounding}")

            # Send meta event with citations
            yield _sse_frame({
                "type": "meta",
                "threadId": thread_id,
                "citations": [c.model_dump() for c in retrieval.citations],
                "grounding": retrieval.grounding,
            })

            # Step 2: Build messages for LLM
            messages = [
                {
                    "role": "system",
                    "content": legal_system_prompt(
                        language=req.language,
                        grounding=retrieval.grounding,
                        context=retrieval.context,
                    ),
                },
                *history,
            ]

            # Step 3: Stream LLM response
            print("[chat] Starting LLM stream...")
            async for delta in stream_answer(messages):
                answer += delta
                yield _sse_frame({"type": "delta", "text": delta})

            print(f"[chat] LLM response complete ({len(answer)} chars)")

            # Step 4: Save assistant message
            add_message(
                thread_id=thread_id,
                role="assistant",
                content=answer,
                citations=[c.model_dump() for c in retrieval.citations],
                grounding=retrieval.grounding,
            )

            # Step 5: Auto-generate title if new thread
            title = get_thread_title(thread_id) or "New consultation"
            if title == "New consultation":
                try:
                    generated = await complete_text([
                        {"role": "user", "content": title_prompt(req.message)}
                    ])
                    if generated:
                        title = generated.strip("\"'")[:80]
                except Exception as e:
                    print(f"[chat] title generation failed: {e}")

            update_thread_title(thread_id, title, req.language)
            yield _sse_frame({"type": "done", "title": title})

        except Exception as e:
            print(f"[chat] ERROR: {e}")
            traceback.print_exc()
            yield _sse_frame({
                "type": "error",
                "message": str(e) or "The assistant could not answer right now.",
            })

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Thread management endpoints ──────────────────────────────────


@app.get("/api/threads")
async def get_threads(sessionId: str = Query(..., min_length=1)):
    threads = list_threads(sessionId)
    return [t.model_dump() for t in threads]


@app.get("/api/threads/{thread_id}")
async def get_thread_endpoint(thread_id: str, sessionId: str = Query(..., min_length=1)):
    result = get_thread(sessionId, thread_id)
    if not result:
        return JSONResponse(status_code=404, content={"error": "Thread not found"})
    return {
        "thread": result["thread"].model_dump(),
        "turns": [t.model_dump() for t in result["turns"]],
    }


@app.delete("/api/threads/{thread_id}")
async def delete_thread_endpoint(thread_id: str, sessionId: str = Query(..., min_length=1)):
    deleted = delete_thread(sessionId, thread_id)
    return {"ok": deleted}


# ── Health check ─────────────────────────────────────────────────


@app.get("/api/health")
async def health():
    return {"status": "ok", "message": "Legal Advisory System backend is running"}


# ── Entry point ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
