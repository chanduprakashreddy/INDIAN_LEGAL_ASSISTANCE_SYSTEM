"""Document enhancement and restoration service.

Combines image processing, OCR, and LLM-based text recovery into a complete
document restoration pipeline.

Enhancement modes:
  - basic:    Grammar, spelling, punctuation
  - professional: Formal language, clarity, formatting
  - legal:    Legal drafting, clause structure, terminology
  - advanced: Comprehensive review including logic, ambiguity, contradictions
  - restoration: Old / faded / blurred / scanned document recovery
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from pathlib import Path
from typing import Optional

import numpy as np

from document_image_processing import (
    auto_enhance,
    create_clean_scan,
    image_to_bytes,
    load_image,
    save_image,
    assess_image_quality,
)
from document_ocr import (
    extract_document_text,
    render_pdf_page_to_image,
    render_all_pdf_pages,
)
from llm import complete_text, stream_answer


# ── Storage paths ────────────────────────────────────────────────

STORAGE_PATH = Path(os.getenv(
    "STORAGE_PATH",
    str(Path(__file__).parent.parent / "storage"),
))
ENHANCED_DIR = STORAGE_PATH / "enhanced"
ENHANCED_DIR.mkdir(parents=True, exist_ok=True)


# ── Text Enhancement (LLM-based) ────────────────────────────────

ENHANCEMENT_PROMPTS = {
    "basic": (
        "You are a text editor. Correct grammar, spelling, and punctuation in the "
        "following text. Do NOT change the meaning, names, dates, amounts, or legal "
        "terms. Return only the corrected text without explanations."
    ),
    "professional": (
        "You are a professional document editor. Rewrite the following text to be "
        "more formal, clear, and professionally formatted. Improve sentence structure "
        "and readability. Preserve all facts, names, dates, amounts, and legal terms "
        "exactly. Return only the improved text."
    ),
    "legal": (
        "You are an expert Indian legal drafter. Improve the following legal text by:\n"
        "1. Improving legal terminology and drafting quality\n"
        "2. Improving clause structures\n"
        "3. Ensuring consistent terminology\n"
        "4. Improving paragraph organization\n"
        "5. Strengthening logical flow\n"
        "Preserve all facts, names, dates, amounts, and identifying information exactly. "
        "Do NOT fabricate legal provisions. Return only the improved text."
    ),
    "advanced": (
        "You are a senior legal document reviewer. Perform a comprehensive review of "
        "the following text:\n"
        "1. Correct grammar, spelling, and punctuation\n"
        "2. Improve formal language and clarity\n"
        "3. Improve legal terminology and drafting\n"
        "4. Identify and flag ambiguous statements with [AMBIGUOUS: ...]\n"
        "5. Identify contradictory statements with [CONTRADICTION: ...]\n"
        "6. Identify incomplete sections with [INCOMPLETE: ...]\n"
        "7. Suggest missing clauses with [SUGGESTION: ...]\n"
        "8. Remove unnecessary repetition\n"
        "9. Improve headings and subheadings\n"
        "Preserve all facts exactly. Return the improved text with inline annotations."
    ),
}


async def enhance_text(
    text: str,
    mode: str = "professional",
    language: str = "en",
) -> dict:
    """Enhance document text using LLM.

    Returns dict with:
      - enhanced_text: str
      - changes_summary: str
      - mode: str
    """
    prompt = ENHANCEMENT_PROMPTS.get(mode, ENHANCEMENT_PROMPTS["professional"])

    from prompts import language_label
    lang = language_label(language)

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": (
            f"Enhance this document text. Respond in {lang}.\n\n"
            f"--- DOCUMENT TEXT ---\n{text[:12000]}"
        )},
    ]

    enhanced = await complete_text(messages)

    # Generate a changes summary
    summary_messages = [
        {"role": "system", "content": (
            "You are a document review assistant. Compare the original and enhanced "
            "versions below and provide a concise bulleted summary of changes made. "
            "Categorize changes as: Grammar, Formatting, Clarity, Legal Terminology, "
            "Structure, or Other."
        )},
        {"role": "user", "content": (
            f"ORIGINAL:\n{text[:4000]}\n\n"
            f"ENHANCED:\n{enhanced[:4000]}\n\n"
            "List the key changes made."
        )},
    ]
    changes_summary = await complete_text(summary_messages)

    return {
        "enhanced_text": enhanced,
        "changes_summary": changes_summary,
        "mode": mode,
        "original_length": len(text),
        "enhanced_length": len(enhanced),
    }


# ── OCR Text Recovery (LLM-based post-processing) ───────────────

async def recover_ocr_text(raw_ocr_text: str, language: str = "en") -> dict:
    """Use LLM to intelligently recover and clean OCR-extracted text.

    Fixes broken words, spacing issues, OCR character errors while
    preserving meaning and NOT inventing missing content.
    """
    from prompts import language_label
    lang = language_label(language)

    messages = [
        {"role": "system", "content": (
            "You are an OCR post-processor for legal documents. The text below was "
            "extracted via OCR from a scanned document and may contain errors.\n\n"
            "Your task:\n"
            "1. Fix obvious OCR spelling errors where context provides confidence\n"
            "2. Fix broken words caused by line breaks (e.g., 'agree ment' → 'agreement')\n"
            "3. Restore proper spacing and paragraph separation\n"
            "4. Fix incorrectly recognized characters (e.g., '0' vs 'O', '1' vs 'l')\n"
            "5. Reconstruct headings and sections where clear from context\n"
            "6. Correct formatting issues\n\n"
            "STRICT RULES:\n"
            "- PRESERVE the original meaning exactly\n"
            "- PRESERVE all names, dates, amounts, legal terms, and identifying info\n"
            "- Mark text you CANNOT confidently recover as [UNCLEAR]\n"
            "- Do NOT guess uncertain names, dates, amounts, or legal clauses\n"
            "- Do NOT invent missing content\n"
            "- Do NOT add legal provisions not present in the original\n\n"
            "Return ONLY a valid JSON object with:\n"
            '"recovered_text" (string — the cleaned, reconstructed text)\n'
            '"corrections_made" (array of strings — list of corrections applied)\n'
            '"uncertain_portions" (array of strings — parts that remain uncertain)\n'
            '"recovery_confidence" (string — "high", "medium", or "low")\n'
        )},
        {"role": "user", "content": (
            f"Process this OCR text. Original document language: {lang}.\n\n"
            f"--- OCR TEXT ---\n{raw_ocr_text[:12000]}"
        )},
    ]

    raw = await complete_text(messages)
    return _parse_recovery_result(raw, raw_ocr_text)


def _parse_recovery_result(raw: str, fallback: str) -> dict:
    """Parse the recovery JSON from LLM."""
    import re
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    candidate = (fenced.group(1) if fenced else raw).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")

    defaults = {
        "recovered_text": fallback,
        "corrections_made": [],
        "uncertain_portions": [],
        "recovery_confidence": "low",
    }

    if start == -1 or end == -1:
        return {**defaults, "recovered_text": raw.strip()}

    try:
        parsed = json.loads(candidate[start:end + 1])
        return {
            "recovered_text": str(parsed.get("recovered_text", fallback)),
            "corrections_made": [str(c) for c in parsed.get("corrections_made", [])],
            "uncertain_portions": [str(u) for u in parsed.get("uncertain_portions", [])],
            "recovery_confidence": str(parsed.get("recovery_confidence", "medium")),
        }
    except (json.JSONDecodeError, ValueError):
        return {**defaults, "recovered_text": raw.strip()}


# ── Image Restoration Pipeline ──────────────────────────────────

async def restore_document_image(
    file_path: str,
    mime_type: str,
    language: str = "en",
) -> dict:
    """Complete pipeline for restoring an old / faded / blurred document image.

    Steps:
      1. Assess image quality
      2. Apply image preprocessing (denoise, deskew, contrast, sharpen, etc.)
      3. Create a clean scan version
      4. Run OCR on both original and enhanced versions
      5. Use LLM to recover and clean the OCR text
      6. Generate a clean digital reconstruction
      7. Save enhanced outputs

    Returns comprehensive result with original, enhanced, and reconstructed data.
    """
    session_id = uuid.uuid4().hex[:12]
    result_dir = ENHANCED_DIR / session_id
    result_dir.mkdir(parents=True, exist_ok=True)

    path = Path(file_path)
    is_pdf = mime_type == "application/pdf" or path.suffix.lower() == ".pdf"

    if is_pdf:
        return await _restore_pdf_document(file_path, result_dir, language)

    if mime_type.startswith("image/") or path.suffix.lower() in (
        ".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".gif", ".webp",
    ):
        return await _restore_image_document(file_path, result_dir, language)

    # For text-based documents, just extract and enhance the text
    extraction = await extract_document_text(file_path, mime_type)
    enhanced = await enhance_text(extraction["full_text"], mode="professional", language=language)
    return {
        "session_id": session_id,
        "original_text": extraction["full_text"],
        "enhanced_text": enhanced["enhanced_text"],
        "changes_summary": enhanced["changes_summary"],
        "is_restoration": False,
        "pages": [],
    }


async def _restore_image_document(
    file_path: str,
    result_dir: Path,
    language: str,
) -> dict:
    """Restore a single image document."""
    img = load_image(file_path)
    quality = assess_image_quality(img)

    # Step 1: Auto-enhance
    enhanced_img, enhancements = auto_enhance(img)

    # Step 2: Create clean scan
    clean_img = create_clean_scan(img)

    # Step 3: Save enhanced versions
    enhanced_path = save_image(enhanced_img, result_dir / "enhanced.png")
    clean_path = save_image(clean_img, result_dir / "clean_scan.png")

    # Step 4: OCR on enhanced version
    enhanced_bytes = image_to_bytes(enhanced_img, ".png")
    from document_ocr import ocr_image_with_gemini
    ocr_result = await ocr_image_with_gemini(enhanced_bytes, "image/png", language)

    # Step 5: LLM-based text recovery
    recovery = None
    if ocr_result["text"]:
        recovery = await recover_ocr_text(ocr_result["text"], language)

    # Build result
    best_text = recovery["recovered_text"] if recovery else ocr_result["text"]

    return {
        "session_id": result_dir.name,
        "is_restoration": True,
        "quality_assessment": quality,
        "enhancements_applied": enhancements,
        "enhanced_image_path": enhanced_path,
        "clean_scan_path": clean_path,
        "ocr_result": ocr_result,
        "recovery": recovery,
        "best_text": best_text,
        "original_text": ocr_result["text"],
        "pages": [{
            "page_number": 1,
            "original_text": ocr_result["text"],
            "recovered_text": best_text,
            "confidence": ocr_result["confidence"],
            "unclear_portions": ocr_result["unclear_portions"],
            "enhancements_applied": enhancements,
        }],
    }


async def _restore_pdf_document(
    file_path: str,
    result_dir: Path,
    language: str,
) -> dict:
    """Restore a scanned PDF document page by page."""
    import fitz

    doc = fitz.open(file_path)
    total_pages = min(len(doc), 20)
    doc.close()

    pages = []
    all_text_parts = []
    all_unclear = []
    all_enhancements = set()

    for page_num in range(total_pages):
        print(f"[restore] Processing page {page_num + 1}/{total_pages}...")

        # Render page
        img = render_pdf_page_to_image(file_path, page_num, dpi=200)
        quality = assess_image_quality(img)

        # Enhance
        enhanced_img, enhancements = auto_enhance(img)
        all_enhancements.update(enhancements)

        # Save enhanced page
        page_path = save_image(
            enhanced_img,
            result_dir / f"page_{page_num + 1:03d}_enhanced.png",
        )

        # OCR
        enhanced_bytes = image_to_bytes(enhanced_img, ".png")
        from document_ocr import ocr_image_with_gemini
        ocr_result = await ocr_image_with_gemini(enhanced_bytes, "image/png", language)

        # Recovery
        recovery = None
        if ocr_result["text"]:
            recovery = await recover_ocr_text(ocr_result["text"], language)

        best_text = recovery["recovered_text"] if recovery else ocr_result["text"]

        pages.append({
            "page_number": page_num + 1,
            "original_text": ocr_result["text"],
            "recovered_text": best_text,
            "confidence": ocr_result["confidence"],
            "unclear_portions": ocr_result["unclear_portions"],
            "enhancements_applied": enhancements,
            "enhanced_image_path": page_path,
            "quality_assessment": quality,
        })

        if best_text:
            all_text_parts.append(f"--- Page {page_num + 1} ---\n{best_text}")
        all_unclear.extend(ocr_result["unclear_portions"])

    return {
        "session_id": result_dir.name,
        "is_restoration": True,
        "total_pages": total_pages,
        "enhancements_applied": list(all_enhancements),
        "best_text": "\n\n".join(all_text_parts),
        "unclear_portions": all_unclear,
        "pages": pages,
    }


# ── Document Enhancement Entry Point ────────────────────────────

async def enhance_document(
    file_path: str,
    mime_type: str,
    mode: str = "professional",
    language: str = "en",
) -> dict:
    """Enhanced document processing — the main entry point for enhancement.

    For images and scanned PDFs → restoration pipeline.
    For text documents → text enhancement pipeline.
    """
    path = Path(file_path)
    is_image = mime_type.startswith("image/") or path.suffix.lower() in (
        ".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".gif", ".webp",
    )

    if mode == "restoration" or is_image:
        return await restore_document_image(file_path, mime_type, language)

    # For text-based documents: extract text then enhance
    extraction = await extract_document_text(file_path, mime_type)
    text = extraction.get("full_text", "")

    if not text.strip():
        # Empty text — try OCR
        if mime_type == "application/pdf":
            return await restore_document_image(file_path, mime_type, language)
        return {"error": "No text could be extracted from this document."}

    enhanced = await enhance_text(text, mode=mode, language=language)

    return {
        "is_restoration": False,
        "mode": mode,
        "original_text": text,
        "enhanced_text": enhanced["enhanced_text"],
        "changes_summary": enhanced["changes_summary"],
        "original_length": enhanced["original_length"],
        "enhanced_length": enhanced["enhanced_length"],
        "pages": extraction.get("pages", []),
    }

