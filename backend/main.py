"""FastAPI backend for the Legal Advisory System.

Provides:
  POST /api/chat            — SSE streaming legal chat (RAG + LLM) with query classification
  POST /api/upload           — Upload documents (images, PDFs) for analysis
  POST /api/analyze-document — Analyze an uploaded document with Gemini multimodal
  POST /api/generate-document — Generate a legal document from requirements
  GET  /api/documents        — List uploaded documents for a session
  GET  /api/uploads/{filename} — Serve uploaded files
  GET  /api/threads          — list conversation threads
  GET  /api/threads/{id}     — get a thread with all messages
  DELETE /api/threads/{id}   — delete a thread

Run with:  python main.py
"""

from __future__ import annotations

import json
import os
import traceback
import uuid
from pathlib import Path
from typing import AsyncGenerator

from dotenv import load_dotenv

# Load .env BEFORE importing anything that reads env vars
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"), override=True)
# Ensure the backend directory is on the Python path for local imports
import sys
sys.path.append(os.path.dirname(__file__))

from fastapi import FastAPI, File, Form, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from database import (
    add_message,
    delete_thread,
    get_document,
    get_history,
    get_or_create_thread,
    get_thread,
    get_thread_documents,
    get_thread_title,
    init_db,
    list_session_documents,
    list_threads,
    save_uploaded_document,
    update_document_analysis,
    update_thread_title,
)
from llm import (
    analyze_document_with_file,
    classify_query,
    complete_text,
    stream_answer,
)
from models import (
    ChatRequest,
    DocumentAnalyzeRequest,
    DocumentGenerateRequest,
    ExportDocumentRequest,
    DocumentEnhanceRequest,
    DocumentRestoreRequest,
    DocumentAuthenticityRequest,
    DocumentCompareRequest,
    DocumentSummarizeRequest,
    DocumentQARequest,
)
from prompts import document_generate_prompt, legal_system_prompt
from retrieval import retrieve_context
from document_enhancement import enhance_document, restore_document_image
from document_authenticity import assess_authenticity
from document_comparison import compare_documents
from document_intelligence import (
    detect_document_intent,
    analyse_document_comprehensive,
    answer_document_question,
)

# ── File storage setup ───────────────────────────────────────────
UPLOAD_DIR = Path(__file__).parent.parent / "storage" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
ENHANCED_DIR = Path(__file__).parent.parent / "storage" / "enhanced"
ENHANCED_DIR.mkdir(parents=True, exist_ok=True)

# ── App setup ────────────────────────────────────────────────────

app = FastAPI(
    title="Legal Advisory System — Backend",
    description="Python FastAPI backend with ChromaDB + BM25 hybrid RAG for Indian law",
    version="2.0.0",
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
    api_key = os.getenv("GOOGLE_API_KEY", "").strip()
    if not api_key or api_key == "paste-your-google-api-key-here":
        print("\n" + "=" * 60)
        print("  WARNING: GOOGLE_API_KEY is NOT set!")
        print("  Edit backend/.env and paste your key.")
        print("  Get one from: https://aistudio.google.com/apikey")
        print("=" * 60 + "\n")
    else:
        print(f"[server] Google API key loaded (ends with ...{api_key[-6:]})")
    print(f"[server] Upload directory: {UPLOAD_DIR}")
    print("[server] SQLite database initialized")
    print("[server] Backend ready at http://localhost:" + str(os.getenv("PORT", "8000")))


# ── Chat endpoint (SSE streaming) ────────────────────────────────


def _sse_frame(payload: dict) -> str:
    """Format a single SSE frame exactly as the frontend expects."""
    return f"data: {json.dumps(payload)}\n\n"


def _build_document_context(thread_id: str) -> str:
    """Build a context string from all documents uploaded to this thread."""
    docs = get_thread_documents(thread_id)
    if not docs:
        return ""

    parts = []
    for i, doc in enumerate(docs, 1):
        header = f"📄 Document {i}: {doc['filename']}"
        analysis = doc.get("analysis")
        cleaned = doc.get("cleanedText")

        if analysis:
            summary = analysis.get("summary", "")
            doc_type = analysis.get("documentType", "Document")
            parties = ", ".join(analysis.get("parties", []))
            obligations = "\n".join(f"  - {o}" for o in analysis.get("obligations", []))
            dates = "\n".join(f"  - {d}" for d in analysis.get("dates", []))
            risks = "\n".join(f"  - {r}" for r in analysis.get("risks", []))
            next_steps = "\n".join(f"  - {s}" for s in analysis.get("nextSteps", []))

            parts.append(
                f"{header} ({doc_type})\n"
                f"Summary: {summary}\n"
                + (f"Parties: {parties}\n" if parties else "")
                + (f"Obligations:\n{obligations}\n" if obligations else "")
                + (f"Dates & Deadlines:\n{dates}\n" if dates else "")
                + (f"Risks:\n{risks}\n" if risks else "")
                + (f"Next Steps:\n{next_steps}\n" if next_steps else "")
            )
        elif cleaned:
            parts.append(f"{header}\nDocument Text:\n{cleaned[:2000]}")
        else:
            parts.append(f"{header} (not yet analyzed)")

    return "\n---\n".join(parts)


@app.post("/api/chat")
async def chat_endpoint(req: ChatRequest):
    """SSE streaming chat — with intelligent query classification and document context."""

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
            # Step 0: Classify the query type
            print(f"[chat] Classifying query: {req.message[:80]}...")
            query_type = await classify_query(req.message, history)
            print(f"[chat] Query classified as: {query_type}")

            # Step 0.5: If files were attached, analyze them first
            if req.fileIds:
                for fid in req.fileIds:
                    doc = get_document(fid)
                    if doc and not doc.get("analysis"):
                        print(f"[chat] Auto-analyzing attached document: {doc['filename']}")
                        try:
                            analysis = await analyze_document_with_file(
                                doc["storedPath"], doc["mimeType"], req.language
                            )
                            update_document_analysis(
                                fid, analysis, analysis.get("cleanedText")
                            )
                        except Exception as e:
                            print(f"[chat] Document analysis failed: {e}")

            # Step 1: Build document context from thread uploads
            doc_context = _build_document_context(thread_id)
            if doc_context:
                print(f"[chat] Including {len(get_thread_documents(thread_id))} document(s) as context")

            # Step 2: Retrieve legal context (RAG)
            print(f"[chat] Retrieving context for: {req.message[:80]}...")
            retrieval = await retrieve_context(req.message)
            print(f"[chat] Retrieved {len(retrieval.citations)} citations, grounding={retrieval.grounding}")

            # Send meta event with citations and query type
            yield _sse_frame({
                "type": "meta",
                "threadId": thread_id,
                "citations": [c.model_dump() for c in retrieval.citations],
                "grounding": retrieval.grounding,
                "queryType": query_type,
            })

            # Step 3: Build messages for LLM with classification-aware prompt
            messages = [
                {
                    "role": "system",
                    "content": legal_system_prompt(
                        language=req.language,
                        grounding=retrieval.grounding,
                        context=retrieval.context,
                        query_type=query_type,
                        document_context=doc_context if doc_context else None,
                    ),
                },
                *history,
            ]

            # Step 4: Stream LLM response
            print("[chat] Starting LLM stream...")
            async for delta in stream_answer(messages):
                answer += delta
                yield _sse_frame({"type": "delta", "text": delta})

            # The model is instructed to cite its sources, but adding a compact
            # reference list makes the citation trail dependable in every chat.
            citation_footer = _append_citation_footer(answer, retrieval.citations)
            if citation_footer != answer:
                footer_delta = citation_footer[len(answer):]
                answer = citation_footer
                yield _sse_frame({"type": "delta", "text": footer_delta})

            print(f"[chat] LLM response complete ({len(answer)} chars)")

            # Step 5: Save assistant message
            add_message(
                thread_id=thread_id,
                role="assistant",
                content=answer,
                citations=[c.model_dump() for c in retrieval.citations],
                grounding=retrieval.grounding,
            )

            # Step 6: Give new threads a local title. A title is convenience
            # metadata and must not spend a second Gemini request per chat.
            title = get_thread_title(thread_id) or "New consultation"
            if title == "New consultation":
                title = " ".join(req.message.strip().split())[:80] or "New consultation"

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


# ── File upload endpoint ─────────────────────────────────────────


@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    sessionId: str = Form(...),
    threadId: str = Form(default=""),
):
    """Upload a document (image, PDF) and store it locally."""
    if not file.filename:
        return JSONResponse(status_code=400, content={"error": "No file provided"})

    # Validate file type
    allowed_types = {
        "application/pdf", "image/jpeg", "image/png", "image/gif",
        "image/webp", "image/bmp", "image/tiff",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
    }
    content_type = file.content_type or "application/octet-stream"
    if content_type not in allowed_types:
        # Be lenient — allow any image/* or common document types
        if not content_type.startswith("image/"):
            return JSONResponse(
                status_code=400,
                content={"error": f"File type '{content_type}' is not supported. Upload images or PDFs."},
            )

    # Read and validate size
    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        return JSONResponse(
            status_code=400,
            content={"error": "File is too large. Maximum size is 20 MB."},
        )

    # Generate unique filename and save
    ext = Path(file.filename).suffix or ".bin"
    stored_name = f"{uuid.uuid4().hex}{ext}"
    stored_path = UPLOAD_DIR / stored_name
    with open(stored_path, "wb") as f:
        f.write(content)

    # Save record in database
    doc_id = save_uploaded_document(
        session_id=sessionId,
        filename=file.filename,
        stored_path=str(stored_path),
        mime_type=content_type,
        file_size=len(content),
        thread_id=threadId if threadId else None,
    )

    print(f"[upload] Saved {file.filename} ({len(content)} bytes) as {stored_name}, id={doc_id}")

    return {
        "id": doc_id,
        "filename": file.filename,
        "mimeType": content_type,
        "fileSize": len(content),
        "storedName": stored_name,
    }


# ── Document analysis endpoint ───────────────────────────────────


@app.post("/api/analyze-document")
async def analyze_document_endpoint(req: DocumentAnalyzeRequest):
    """Analyze an uploaded document using Gemini multimodal AI."""
    doc = get_document(req.documentId)
    if not doc:
        return JSONResponse(status_code=404, content={"error": "Document not found"})

    try:
        print(f"[analyze] Analyzing document: {doc['filename']}")
        analysis = await analyze_document_with_file(
            doc["storedPath"], doc["mimeType"], req.language
        )

        # Save the analysis
        update_document_analysis(
            req.documentId, analysis, analysis.get("cleanedText")
        )

        print(f"[analyze] Analysis complete for: {doc['filename']}")
        return {
            "id": req.documentId,
            "analysis": analysis,
        }

    except Exception as e:
        print(f"[analyze] ERROR: {e}")
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e) or "The document could not be analyzed."},
        )


# ── Document generation endpoint ─────────────────────────────────


@app.post("/api/generate-document")
async def generate_document_endpoint(req: DocumentGenerateRequest):
    """Generate a legal document using RAG + Gemini."""
    try:
        print(f"[generate] Generating {req.docType} document...")

        # Build details from fields or freeText
        if req.fields:
            details = "\n".join(
                f"- {key}: {value.strip()}"
                for key, value in req.fields.items()
                if value.strip()
            )
        elif req.freeText:
            details = req.freeText
        else:
            details = "No details provided."

        # Retrieve legal context
        retrieval = await retrieve_context(
            f"{req.docType} format and legal requirements under Indian law "
            f"{details[:400]}"
        )

        rag_context = ""
        if retrieval.context:
            rag_context = (
                "Relevant statutory passages for reference (cite section numbers "
                "inside the document only when you are certain):\n\n"
                + retrieval.context
            )

        # Generate the document
        system_prompt, user_msg = document_generate_prompt(
            req.docType, details, req.language, rag_context
        )

        content = await complete_text([
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ])

        print(f"[generate] Document generated ({len(content)} chars)")

        return {
            "content": content,
            "docType": req.docType,
            "citations": [c.model_dump() for c in retrieval.citations],
        }

    except Exception as e:
        print(f"[generate] ERROR: {e}")
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e) or "The document could not be generated."},
        )


# ── List documents endpoint ──────────────────────────────────────


@app.get("/api/documents")
async def list_documents(sessionId: str = Query(..., min_length=1)):
    """List all uploaded documents for a session."""
    docs = list_session_documents(sessionId)
    return docs


# ── Serve uploaded files ──────────────────────────────────────────


@app.get("/api/uploads/{filename}")
async def serve_upload(filename: str):
    """Serve an uploaded file by its stored filename."""
    file_path = UPLOAD_DIR / filename
    if not file_path.exists() or not file_path.is_file():
        return JSONResponse(status_code=404, content={"error": "File not found"})
    return FileResponse(str(file_path))


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


# ── Document export endpoints (PDF & Word DOCX) ──────────────────


@app.post("/api/export-pdf")
async def export_pdf(req: ExportDocumentRequest):
    """Convert markdown content to a downloadable styled PDF."""
    import io
    import markdown as md
    from xhtml2pdf import pisa

    html_body = md.markdown(
        req.content,
        extensions=["tables", "fenced_code", "nl2br", "sane_lists"],
    )

    html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {{
    size: A4;
    margin: 2.5cm 2cm;
    @frame footer {{
      -pdf-frame-content: footerContent;
      bottom: 0.5cm;
      margin-left: 2cm;
      margin-right: 2cm;
      height: 1cm;
    }}
  }}
  body {{
    font-family: "Noto Sans", "Segoe UI", "Arial Unicode MS", "Helvetica", sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #1a1a1a;
  }}
  h1 {{
    font-size: 16pt;
    text-align: center;
    text-transform: uppercase;
    margin-bottom: 18pt;
    border-bottom: 2px solid #333;
    padding-bottom: 8pt;
  }}
  h2 {{
    font-size: 13pt;
    margin-top: 16pt;
    margin-bottom: 8pt;
    color: #2c3e50;
  }}
  h3 {{
    font-size: 11.5pt;
    margin-top: 12pt;
    margin-bottom: 6pt;
  }}
  p {{ margin: 6pt 0; text-align: justify; }}
  ul, ol {{ margin: 6pt 0; padding-left: 24pt; }}
  li {{ margin: 3pt 0; }}
  table {{
    width: 100%;
    border-collapse: collapse;
    margin: 10pt 0;
  }}
  th, td {{
    border: 1px solid #ccc;
    padding: 6pt 8pt;
    text-align: left;
    font-size: 10pt;
  }}
  th {{ background-color: #f0f0f0; font-weight: bold; }}
  strong {{ font-weight: bold; }}
  em {{ font-style: italic; }}
  code {{
    font-family: "Courier New", monospace;
    font-size: 10pt;
    background-color: #f5f5f5;
    padding: 1pt 3pt;
  }}
  .header-title {{
    text-align: center;
    font-size: 15pt;
    font-weight: bold;
    margin-bottom: 14pt;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }}
</style>
</head>
<body>
  <div class="header-title">{req.title}</div>
  {html_body}
  <div id="footerContent" style="text-align: center; font-size: 8pt; color: #888;">
    Generated by NyayaSahay Legal Advisory System
  </div>
</body>
</html>"""

    buffer = io.BytesIO()
    pisa_status = pisa.CreatePDF(html.encode("utf-8"), dest=buffer, encoding="utf-8")

    if pisa_status.err:
        return JSONResponse(
            status_code=500,
            content={"error": "PDF generation failed"},
        )

    buffer.seek(0)
    safe_title = "".join(c if c.isalnum() or c in " -_" else "_" for c in req.title)[:60]
    filename = f"{safe_title.strip() or 'legal_document'}.pdf"

    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@app.post("/api/export-docx")
async def export_docx(req: ExportDocumentRequest):
    """Convert markdown/text content to a downloadable Word (.docx) document."""
    import io
    import re
    import docx
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Inches, Pt, RGBColor

    doc = docx.Document()

    # Standard A4-friendly 1-inch margins
    for section in doc.sections:
        section.top_margin = Inches(1)
        section.bottom_margin = Inches(1)
        section.left_margin = Inches(1)
        section.right_margin = Inches(1)

    # Document Title
    title_p = doc.add_paragraph()
    title_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_run = title_p.add_run(req.title.upper())
    title_run.bold = True
    title_run.font.size = Pt(16)
    title_run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x1A)

    lines = req.content.split("\n")
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        if stripped.startswith("### "):
            p = doc.add_paragraph()
            run = p.add_run(stripped[4:].strip())
            run.bold = True
            run.font.size = Pt(12)
            run.font.color.rgb = RGBColor(0x2C, 0x3E, 0x50)
        elif stripped.startswith("## "):
            p = doc.add_paragraph()
            run = p.add_run(stripped[3:].strip())
            run.bold = True
            run.font.size = Pt(14)
            run.font.color.rgb = RGBColor(0x1A, 0x36, 0x5D)
        elif stripped.startswith("# "):
            p = doc.add_paragraph()
            run = p.add_run(stripped[2:].strip())
            run.bold = True
            run.font.size = Pt(15)
            run.font.color.rgb = RGBColor(0x1A, 0x1A, 0x1A)
        elif stripped.startswith(("- ", "* ", "• ")):
            bullet_text = stripped[2:].strip()
            p = doc.add_paragraph(style="List Bullet")
            parts = re.split(r"(\*\*.*?\*\*)", bullet_text)
            for part in parts:
                if part.startswith("**") and part.endswith("**"):
                    p.add_run(part[2:-2]).bold = True
                else:
                    p.add_run(part)
        elif re.match(r"^\d+\.\s+", stripped):
            num_match = re.match(r"^(\d+\.\s+)(.*)", stripped)
            p = doc.add_paragraph(style="List Number")
            if num_match:
                item_text = num_match.group(2)
                parts = re.split(r"(\*\*.*?\*\*)", item_text)
                for part in parts:
                    if part.startswith("**") and part.endswith("**"):
                        p.add_run(part[2:-2]).bold = True
                    else:
                        p.add_run(part)
        else:
            p = doc.add_paragraph()
            parts = re.split(r"(\*\*.*?\*\*)", stripped)
            for part in parts:
                if part.startswith("**") and part.endswith("**"):
                    p.add_run(part[2:-2]).bold = True
                elif part.startswith("*") and part.endswith("*"):
                    p.add_run(part[1:-1]).italic = True
                else:
                    p.add_run(part)

    # Footer note
    footer_p = doc.add_paragraph()
    footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer_run = footer_p.add_run("\nGenerated by NyayaSahay Legal Advisory System")
    footer_run.font.size = Pt(9)
    footer_run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
    footer_run.italic = True

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    safe_title = "".join(c if c.isalnum() or c in " -_" else "_" for c in req.title)[:60]
    filename = f"{safe_title.strip() or 'legal_document'}.docx"

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


# ── Document Intelligence endpoints ──────────────────────────────


@app.post("/api/document-intelligence/enhance")
async def enhance_document_endpoint(req: DocumentEnhanceRequest):
    """Enhance a document's text using LLM-based improvement."""
    doc = get_document(req.documentId)
    if not doc:
        return JSONResponse(status_code=404, content={"error": "Document not found"})

    try:
        print(f"[enhance] Enhancing document: {doc['filename']} (mode={req.mode})")
        result = await enhance_document(
            doc["storedPath"], doc["mimeType"], req.mode, req.language
        )
        print(f"[enhance] Enhancement complete for: {doc['filename']}")
        return {"id": req.documentId, "filename": doc["filename"], **result}

    except Exception as e:
        print(f"[enhance] ERROR: {e}")
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e) or "Document enhancement failed."},
        )


@app.post("/api/document-intelligence/restore")
async def restore_document_endpoint(req: DocumentRestoreRequest):
    """Restore an old, faded, or damaged document."""
    doc = get_document(req.documentId)
    if not doc:
        return JSONResponse(status_code=404, content={"error": "Document not found"})

    try:
        print(f"[restore] Restoring document: {doc['filename']}")
        result = await restore_document_image(
            doc["storedPath"], doc["mimeType"], req.language
        )
        print(f"[restore] Restoration complete for: {doc['filename']}")
        return {"id": req.documentId, "filename": doc["filename"], **result}

    except Exception as e:
        print(f"[restore] ERROR: {e}")
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e) or "Document restoration failed."},
        )


@app.post("/api/document-intelligence/authenticity")
async def authenticity_document_endpoint(req: DocumentAuthenticityRequest):
    """Assess the authenticity of a document."""
    doc = get_document(req.documentId)
    if not doc:
        return JSONResponse(status_code=404, content={"error": "Document not found"})

    try:
        print(f"[authenticity] Assessing document: {doc['filename']}")
        result = await assess_authenticity(
            doc["storedPath"], doc["mimeType"], req.language
        )
        print(f"[authenticity] Assessment complete for: {doc['filename']}")
        return {"id": req.documentId, "filename": doc["filename"], **result}

    except Exception as e:
        print(f"[authenticity] ERROR: {e}")
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e) or "Authenticity assessment failed."},
        )


@app.post("/api/document-intelligence/compare")
async def compare_documents_endpoint(req: DocumentCompareRequest):
    """Compare two documents and identify differences."""
    doc1 = get_document(req.documentId1)
    doc2 = get_document(req.documentId2)
    if not doc1:
        return JSONResponse(status_code=404, content={"error": "First document not found"})
    if not doc2:
        return JSONResponse(status_code=404, content={"error": "Second document not found"})

    try:
        print(f"[compare] Comparing: {doc1['filename']} vs {doc2['filename']}")
        result = await compare_documents(
            doc1["storedPath"], doc1["mimeType"],
            doc2["storedPath"], doc2["mimeType"],
            req.language,
        )
        print(f"[compare] Comparison complete")
        return {
            "document1": {"id": req.documentId1, "filename": doc1["filename"]},
            "document2": {"id": req.documentId2, "filename": doc2["filename"]},
            **result,
        }

    except Exception as e:
        print(f"[compare] ERROR: {e}")
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e) or "Document comparison failed."},
        )


@app.post("/api/document-intelligence/summarize")
async def summarize_document_endpoint(req: DocumentSummarizeRequest):
    """Provide a comprehensive analysis and summary of a document."""
    doc = get_document(req.documentId)
    if not doc:
        return JSONResponse(status_code=404, content={"error": "Document not found"})

    try:
        print(f"[summarize] Analyzing document: {doc['filename']}")
        result = await analyse_document_comprehensive(
            doc["storedPath"], doc["mimeType"], req.language
        )
        print(f"[summarize] Analysis complete for: {doc['filename']}")
        return {"id": req.documentId, "filename": doc["filename"], **result}

    except Exception as e:
        print(f"[summarize] ERROR: {e}")
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e) or "Document summarization failed."},
        )


@app.post("/api/document-intelligence/qa")
async def document_qa_endpoint(req: DocumentQARequest):
    """Answer a specific question about an uploaded document."""
    doc = get_document(req.documentId)
    if not doc:
        return JSONResponse(status_code=404, content={"error": "Document not found"})

    try:
        print(f"[doc-qa] Question about {doc['filename']}: {req.question[:60]}...")
        answer = await answer_document_question(
            req.question, doc["storedPath"], doc["mimeType"], req.language
        )
        print(f"[doc-qa] Answer generated ({len(answer)} chars)")
        return {
            "id": req.documentId,
            "filename": doc["filename"],
            "question": req.question,
            "answer": answer,
        }

    except Exception as e:
        print(f"[doc-qa] ERROR: {e}")
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e) or "Could not answer the question."},
        )


@app.get("/api/document-intelligence/enhanced/{filename}")
async def serve_enhanced_file(filename: str):
    """Serve an enhanced or restored document file."""
    file_path = ENHANCED_DIR / filename
    if not file_path.exists() or not file_path.is_file():
        return JSONResponse(status_code=404, content={"error": "Enhanced file not found"})
    return FileResponse(str(file_path))


# ── Health check ─────────────────────────────────────────────────


@app.get("/api/health")
async def health():
    return {"status": "ok", "message": "Legal Advisory System backend is running"}


# ── Entry point ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
def _append_citation_footer(answer: str, citations: list) -> str:
    """Ensure every streamed answer exposes its retrieved sources in the chat UI.

    The numbered references are rendered as clickable citation chips by the
    frontend.  This also gives users a visible citation trail when the model
    did not place a bracketed citation in its prose.
    """
    if not answer.strip() or not citations:
        return answer

    sources = []
    for citation in citations:
        label = citation.actName
        if citation.section:
            label += f", Section {citation.section}"
        sources.append(f"- [{citation.index}] {label}")
    return f"{answer.rstrip()}\n\n### Sources\n" + "\n".join(sources)
