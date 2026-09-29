"""SQLite-based chat persistence — replaces Supabase for chat threads/messages."""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from models import ChatTurn, Citation, ThreadSummary

DB_PATH = Path(__file__).parent / "chat.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create tables if they don't exist."""
    conn = _connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS chat_threads (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT 'New consultation',
            language TEXT NOT NULL DEFAULT 'en',
            matter_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_threads_session
            ON chat_threads(session_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            citations TEXT NOT NULL DEFAULT '[]',
            grounding TEXT NOT NULL DEFAULT 'none',
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread
            ON chat_messages(thread_id, created_at ASC);
        """
    )
    conn.commit()
    conn.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Thread operations ──────────────────────────────────────────────


def get_or_create_thread(
    session_id: str,
    thread_id: Optional[str] = None,
    matter_id: Optional[str] = None,
    language: str = "en",
) -> str:
    """Return an existing thread_id if valid, or create a new one."""
    conn = _connect()

    if thread_id:
        row = conn.execute(
            "SELECT id FROM chat_threads WHERE id = ? AND session_id = ?",
            (thread_id, session_id),
        ).fetchone()
        if row:
            conn.close()
            return str(row["id"])

    new_id = str(uuid.uuid4())
    now = _now()
    conn.execute(
        """INSERT INTO chat_threads (id, session_id, title, language, matter_id, created_at, updated_at)
           VALUES (?, ?, 'New consultation', ?, ?, ?, ?)""",
        (new_id, session_id, language, matter_id, now, now),
    )
    conn.commit()
    conn.close()
    return new_id


def list_threads(session_id: str) -> list[ThreadSummary]:
    conn = _connect()
    rows = conn.execute(
        """SELECT id, title, language, matter_id, updated_at
           FROM chat_threads WHERE session_id = ?
           ORDER BY updated_at DESC LIMIT 60""",
        (session_id,),
    ).fetchall()
    conn.close()
    return [
        ThreadSummary(
            id=r["id"],
            title=r["title"],
            language=r["language"],
            matterId=r["matter_id"],
            updatedAt=r["updated_at"],
        )
        for r in rows
    ]


def get_thread(
    session_id: str, thread_id: str
) -> Optional[dict]:
    conn = _connect()
    thread_row = conn.execute(
        """SELECT id, title, language, matter_id, updated_at
           FROM chat_threads WHERE id = ? AND session_id = ?""",
        (thread_id, session_id),
    ).fetchone()
    if not thread_row:
        conn.close()
        return None

    msg_rows = conn.execute(
        """SELECT id, role, content, citations, grounding, created_at
           FROM chat_messages WHERE thread_id = ?
           ORDER BY created_at ASC""",
        (thread_id,),
    ).fetchall()
    conn.close()

    return {
        "thread": ThreadSummary(
            id=thread_row["id"],
            title=thread_row["title"],
            language=thread_row["language"],
            matterId=thread_row["matter_id"],
            updatedAt=thread_row["updated_at"],
        ),
        "turns": [
            ChatTurn(
                id=m["id"],
                role=m["role"],
                content=m["content"],
                citations=json.loads(m["citations"]),
                grounding=m["grounding"],
                createdAt=m["created_at"],
            )
            for m in msg_rows
        ],
    }


def delete_thread(session_id: str, thread_id: str) -> bool:
    conn = _connect()
    cursor = conn.execute(
        "DELETE FROM chat_threads WHERE id = ? AND session_id = ?",
        (thread_id, session_id),
    )
    conn.commit()
    deleted = cursor.rowcount > 0
    conn.close()
    return deleted


# ── Message operations ─────────────────────────────────────────────


def add_message(
    thread_id: str,
    role: str,
    content: str,
    citations: list[dict] | None = None,
    grounding: str = "none",
) -> str:
    msg_id = str(uuid.uuid4())
    conn = _connect()
    conn.execute(
        """INSERT INTO chat_messages (id, thread_id, role, content, citations, grounding, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (msg_id, thread_id, role, content, json.dumps(citations or []), grounding, _now()),
    )
    conn.commit()
    conn.close()
    return msg_id


def get_history(thread_id: str, limit: int = 24) -> list[dict]:
    conn = _connect()
    rows = conn.execute(
        """SELECT role, content FROM chat_messages
           WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?""",
        (thread_id, limit),
    ).fetchall()
    conn.close()
    return [{"role": r["role"], "content": r["content"]} for r in rows]


def update_thread_title(thread_id: str, title: str, language: str = "en") -> None:
    conn = _connect()
    conn.execute(
        "UPDATE chat_threads SET title = ?, language = ?, updated_at = ? WHERE id = ?",
        (title, language, _now(), thread_id),
    )
    conn.commit()
    conn.close()


def get_thread_title(thread_id: str) -> Optional[str]:
    conn = _connect()
    row = conn.execute("SELECT title FROM chat_threads WHERE id = ?", (thread_id,)).fetchone()
    conn.close()
    return row["title"] if row else None
