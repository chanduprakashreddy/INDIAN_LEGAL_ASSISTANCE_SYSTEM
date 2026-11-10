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
    fileIds: list[str] = Field(default_factory=list)


class DocumentAnalyzeRequest(BaseModel):
    sessionId: str = Field(..., min_length=1)
    documentId: str = Field(..., min_length=1)
    language: str = Field(default="en", min_length=2, max_length=5)


class DocumentGenerateRequest(BaseModel):
    sessionId: str = Field(..., min_length=1)
    docType: str = Field(..., min_length=2, max_length=60)
    language: str = Field(default="en", min_length=2, max_length=5)
    fields: dict[str, str] = Field(default_factory=dict)
    freeText: Optional[str] = None
    threadId: Optional[str] = None


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


class DocumentAnalysis(BaseModel):
    documentType: str = "Legal document"
    summary: str = ""
    parties: list[str] = []
    obligations: list[str] = []
    dates: list[str] = []
    risks: list[str] = []
    nextSteps: list[str] = []
    quality: str = ""
    cleanedText: Optional[str] = None


class ExportDocumentRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=100000)
    title: str = Field(default="Legal Document")
