"""Document Intelligence — main coordinator service.

Provides a single entry-point for all document intelligence operations
and the chat-based intent routing.  Each operation delegates to the
appropriate specialized service.

Operations:
  1. generate    — AI document generation (RAG-powered)
  2. enhance     — Text enhancement (grammar/professional/legal/advanced)
  3. restore     — Old/faded/blurred document restoration
  4. analyse     — Document analysis and understanding
  5. authenticity — Fake/suspicious document detection
  6. compare     — Document version comparison
  7. summarize   — Multi-level summarization
  8. risk        — Risk analysis
  9. qa          — Question answering from uploaded documents
"""

from __future__ import annotations

import json
import re
import traceback
from typing import AsyncGenerator, Optional

from llm import complete_text, stream_answer
from prompts import language_label
from retrieval import retrieve_context


# ── Intent Detection ─────────────────────────────────────────────

DOCUMENT_INTENTS = {
    "generate": [
        "generate", "draft", "create", "write", "prepare", "make",
        "legal notice", "agreement", "affidavit", "application",
        "petition", "complaint", "contract", "nda", "mou",
        "memorandum", "partnership", "employment", "rental",
        "lease", "power of attorney", "rti",
    ],
    "enhance": [
        "enhance", "improve", "rewrite", "professional", "formal",
        "grammar", "better language", "more formal", "polish",
        "clean up", "edit this", "make it better",
    ],
    "restore": [
        "restore", "faded", "blurry", "blurred", "unclear", "old document",
        "not readable", "cannot read", "can't read", "difficult to read",
        "poor quality", "low quality", "scanned", "make it readable",
        "improve clarity", "recover text", "clean copy",
        "convert to digital", "digital copy",
    ],
    "analyse": [
        "analyse", "analyze", "explain", "understand", "what is this",
        "what does this", "break down", "interpret", "meaning",
    ],
    "authenticity": [
        "fake", "genuine", "authentic", "forged", "manipulated",
        "tampered", "suspicious", "verify", "real or fake",
        "is this real", "check authenticity", "fraud",
    ],
    "compare": [
        "compare", "difference", "changes", "what changed",
        "version", "two documents", "both documents",
    ],
    "summarize": [
        "summarize", "summary", "brief", "key points",
        "main points", "overview", "important points",
        "tldr", "in short",
    ],
    "risk": [
        "risk", "risky", "dangerous", "problematic", "concern",
        "issue", "red flag", "warning", "trap", "hidden",
        "one-sided", "unfair", "ambiguous",
    ],
    "qa": [
        "what are the", "who are the", "what is the",
        "how much", "when does", "what happens if",
        "parties involved", "obligations", "duration",
        "termination", "breach", "penalty",
    ],
}


def detect_document_intent(
    message: str,
    has_files: bool = False,
    history: list[dict] | None = None,
) -> Optional[str]:
    """Detect the document-related intent from a user message.

    Returns the intent name or None if not a document-related request.
    Uses keyword matching augmented with context awareness.
    """
    msg_lower = message.lower().strip()

    # Score each intent
    scores: dict[str, float] = {}
    for intent, keywords in DOCUMENT_INTENTS.items():
        score = 0.0
        for keyword in keywords:
            if keyword in msg_lower:
                # Longer keyword phrases are more specific
                score += len(keyword.split()) * 1.5
        scores[intent] = score

    # Boost scores based on context
    if has_files:
        # With files attached, analysis/enhancement/restoration are more likely
        for intent in ("analyse", "enhance", "restore", "authenticity", "summarize", "risk", "qa"):
            scores[intent] = scores.get(intent, 0) + 1.0

    # Check if any intent has a meaningful score
    best_intent = max(scores, key=scores.get) if scores else None
    best_score = scores.get(best_intent, 0) if best_intent else 0

    if best_score < 1.0:
        return None  # Not a document-related request

    return best_intent


# ── Document Generation (Enhanced) ──────────────────────────────

async def generate_document_from_chat(
    message: str,
    language: str = "en",
    context: Optional[str] = None,
) -> AsyncGenerator[dict, None]:
    """Generate a legal document from a natural-language chat message.

    This is the chat-integrated version that:
    1. Understands the user's intent
    2. Identifies the document type
    3. Retrieves relevant legal context via RAG
    4. Generates the document with citations
    5. Streams the result
    """
    lang = language_label(language)

    # Step 1: Retrieve relevant legal context
    retrieval = await retrieve_context(message)
    rag_context = ""
    if retrieval.context:
        rag_context = (
            "Relevant statutory passages for reference (cite section numbers "
            "inside the document only when you are certain):\n\n"
            + retrieval.context
        )

    # Step 2: Build generation prompt
    system_prompt = "\n".join([
        "You draft Indian legal documents that are ready to print, stamp and file.",
        "Follow standard Indian drafting conventions: title in capitals, numbered paragraphs,",
        "verification clause where applicable, place and date lines, signature blocks,",
        "and a list of enclosures when relevant.",
        "",
        "Use [SQUARE BRACKETS] for anything the user must still fill in.",
        "Never invent facts, names, case numbers or dates that were not supplied.",
        f"Write the document in {lang}.",
        "",
        "IMPORTANT: Before generating, identify what information is MISSING.",
        "If essential details are missing (like names, addresses, specific facts),",
        "ASK the user for them first. Do not generate an incomplete document.",
        "If you have enough information to produce a useful draft, proceed.",
        "",
        "After the document, add:",
        "📝 **Usage Notes** — how to print/use, stamp paper value, notarization needed,",
        "where to file, any fees.",
        "",
        f"\n{rag_context}" if rag_context else "",
    ])

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": message},
    ]

    if context:
        messages.insert(1, {"role": "assistant", "content": context})

    # Step 3: Stream the document
    yield {
        "type": "meta",
        "operation": "document_generate",
        "citations": [c.model_dump() for c in retrieval.citations],
        "grounding": retrieval.grounding,
    }

    full_text = ""
    async for delta in stream_answer(messages):
        full_text += delta
        yield {"type": "delta", "text": delta}

    yield {"type": "done", "operation": "document_generate"}


# ── Document Analysis (Enhanced) ────────────────────────────────

async def analyse_document_comprehensive(
    file_path: str,
    mime_type: str,
    language: str = "en",
    analysis_type: str = "full",
) -> dict:
    """Comprehensive document analysis with multiple analysis levels.

    analysis_type: "full", "summary", "risk", "qa"
    """
    from document_ocr import extract_document_text
    from llm import analyze_document_with_file

    # Get the basic analysis from existing multimodal system
    basic_analysis = await analyze_document_with_file(file_path, mime_type, language)

    # Also extract full text for deeper analysis
    try:
        extraction = await extract_document_text(file_path, mime_type)
        full_text = extraction.get("full_text", "")
    except Exception:
        full_text = basic_analysis.get("cleanedText", "")

    result = {
        "basic_analysis": basic_analysis,
        "full_text": full_text,
        "extraction_info": {
            "total_pages": extraction.get("total_pages", 1) if 'extraction' in dir() else 1,
        },
    }

    # Add risk analysis if requested
    if analysis_type in ("full", "risk"):
        risk = await _perform_risk_analysis(full_text or str(basic_analysis), language)
        result["risk_analysis"] = risk

    # Add detailed summary if requested
    if analysis_type in ("full", "summary"):
        summaries = await _generate_summaries(full_text or str(basic_analysis), language)
        result["summaries"] = summaries

    return result


async def _perform_risk_analysis(text: str, language: str) -> dict:
    """Analyse document for potential risks and concerns."""
    lang = language_label(language)

    messages = [
        {"role": "system", "content": (
            "You are a senior legal document reviewer specialising in Indian law. "
            "Analyse the following document text and identify potential risks and concerns.\n\n"
            "For each finding, provide:\n"
            "- title: Brief issue title\n"
            "- explanation: Detailed explanation\n"
            "- severity: Low, Medium, or High\n"
            "- section: Relevant section/clause if identifiable\n"
            "- reason: Why this is a concern\n"
            "- recommendation: Suggested action\n\n"
            "Look for:\n"
            "- Ambiguous clauses\n"
            "- Missing important conditions\n"
            "- Contradictory statements\n"
            "- Unclear payment terms\n"
            "- One-sided obligations\n"
            "- Missing dates or signatures\n"
            "- Unclear termination conditions\n"
            "- Potentially problematic provisions\n\n"
            "IMPORTANT:\n"
            "- Do NOT declare a clause unlawful merely because it is unusual\n"
            "- Distinguish between drafting concerns and confirmed violations\n"
            "- Be balanced and practical\n\n"
            "Return ONLY valid JSON with:\n"
            '"findings" (array of risk objects)\n'
            '"overall_risk_level" (string: "low", "medium", "high")\n'
            '"summary" (string: brief risk summary)\n'
        )},
        {"role": "user", "content": f"Analyse this document ({lang}):\n\n{text[:10000]}"},
    ]

    raw = await complete_text(messages)
    return _parse_risk_result(raw)


def _parse_risk_result(raw: str) -> dict:
    """Parse risk analysis JSON."""
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    candidate = (fenced.group(1) if fenced else raw).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")

    if start == -1 or end == -1:
        return {"findings": [], "overall_risk_level": "unknown", "summary": raw[:500]}

    try:
        parsed = json.loads(candidate[start:end + 1])
        return {
            "findings": [
                {
                    "title": str(f.get("title", "")),
                    "explanation": str(f.get("explanation", "")),
                    "severity": str(f.get("severity", "low")),
                    "section": str(f.get("section", "")),
                    "reason": str(f.get("reason", "")),
                    "recommendation": str(f.get("recommendation", "")),
                }
                for f in parsed.get("findings", [])
                if isinstance(f, dict)
            ],
            "overall_risk_level": str(parsed.get("overall_risk_level", "unknown")),
            "summary": str(parsed.get("summary", "")),
        }
    except (json.JSONDecodeError, ValueError):
        return {"findings": [], "overall_risk_level": "unknown", "summary": raw[:500]}


async def _generate_summaries(text: str, language: str) -> dict:
    """Generate multiple levels of document summaries."""
    lang = language_label(language)

    messages = [
        {"role": "system", "content": (
            "You are a legal document summarizer. Generate multiple summary levels "
            "for the document below.\n\n"
            "Return ONLY valid JSON with:\n"
            '"quick_summary" (string — 2-3 sentences)\n'
            '"detailed_summary" (string — comprehensive paragraph)\n'
            '"key_points" (array of strings — important points)\n'
            '"obligations" (array of strings — key obligations)\n'
            '"risks_and_concerns" (array of strings — notable risks)\n'
            '"dates_and_deadlines" (array of strings — important dates)\n'
            '"parties_and_roles" (array of strings — parties and their roles)\n'
        )},
        {"role": "user", "content": f"Summarize this document ({lang}):\n\n{text[:10000]}"},
    ]

    raw = await complete_text(messages)
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    candidate = (fenced.group(1) if fenced else raw).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")

    if start == -1 or end == -1:
        return {"quick_summary": raw[:500]}

    try:
        parsed = json.loads(candidate[start:end + 1])
        return {
            "quick_summary": str(parsed.get("quick_summary", "")),
            "detailed_summary": str(parsed.get("detailed_summary", "")),
            "key_points": [str(p) for p in parsed.get("key_points", [])],
            "obligations": [str(o) for o in parsed.get("obligations", [])],
            "risks_and_concerns": [str(r) for r in parsed.get("risks_and_concerns", [])],
            "dates_and_deadlines": [str(d) for d in parsed.get("dates_and_deadlines", [])],
            "parties_and_roles": [str(p) for p in parsed.get("parties_and_roles", [])],
        }
    except (json.JSONDecodeError, ValueError):
        return {"quick_summary": raw[:500]}


# ── Question Answering ──────────────────────────────────────────

async def answer_document_question(
    question: str,
    document_text: str,
    language: str = "en",
) -> str:
    """Answer a question about a specific uploaded document.

    Grounds the answer in the uploaded document content.
    May also retrieve relevant legal context via RAG.
    """
    lang = language_label(language)

    # Optionally retrieve legal context for the question
    retrieval = await retrieve_context(question)
    rag_context = ""
    if retrieval.context:
        rag_context = (
            "\n\nAdditional legal context from the knowledge base:\n"
            + retrieval.context
        )

    messages = [
        {"role": "system", "content": (
            f"You are a legal document analyst. Answer the user's question based on "
            f"the uploaded document content below.\n\n"
            f"RULES:\n"
            f"1. Ground your answer in the UPLOADED DOCUMENT content\n"
            f"2. If additional legal context is provided, you may reference it but "
            f"clearly distinguish it from the document's own content\n"
            f"3. If the answer cannot be found in the document, say so\n"
            f"4. Quote relevant portions of the document\n"
            f"5. Reference page numbers or sections when available\n"
            f"6. Be thorough and helpful\n"
            f"7. Respond in {lang}\n\n"
            f"UPLOADED DOCUMENT CONTENT:\n{document_text[:10000]}"
            f"{rag_context}"
        )},
        {"role": "user", "content": question},
    ]

    return await complete_text(messages)

