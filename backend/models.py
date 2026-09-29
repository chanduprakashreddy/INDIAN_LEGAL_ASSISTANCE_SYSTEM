"""Pydantic models for the Legal Advisory System backend."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    sessionId: str = Field(..., min_length=1)
    threadId: Optional[str] = None
    matterId: Optional[str] = None
    message: str = Field(..., min_length=1, max_length=8000)
    language: str = Field(default="en", min_length=2, max_length=5)


class Citation(BaseModel):
    index: int
    actName: str
    section: Optional[str] = None
    year: Optional[int] = None
    sourceUrl: Optional[str] = None
    excerpt: str
    origin: Literal["corpus", "indiacode", "webscrape"]
    score: Optional[float] = None


class RetrievalResult(BaseModel):
    citations: list[Citation]
    context: str
    grounding: Literal["corpus", "indiacode", "webscrape", "none"]


class ThreadSummary(BaseModel):
    id: str
    title: str
    language: str
    matterId: Optional[str] = None
    updatedAt: str


class ChatTurn(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    citations: list[Citation] = []
    grounding: Literal["corpus", "indiacode", "webscrape", "none"] = "none"
    createdAt: str
