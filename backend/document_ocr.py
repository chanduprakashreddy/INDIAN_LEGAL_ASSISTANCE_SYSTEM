"""Document OCR and text extraction service.

Strategy:
  - Text-based PDFs:  extract text directly with PyMuPDF (fitz)
  - Image-based PDFs: render pages to images, enhance, then use Gemini multimodal
  - Images (PNG/JPG): enhance, then use Gemini multimodal for OCR
  - DOCX/TXT:         extract text with python-docx / read directly

Tesseract is not available on this system, so OCR is performed by Gemini's
multimodal vision model, which produces superior results on degraded,
handwritten, and multilingual documents compared to local OCR.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF
import numpy as np

from document_image_processing import (
    auto_enhance,
    bytes_to_image,
    create_clean_scan,
    image_to_bytes,
    load_image,
)


# ── Text extraction from different formats ──────────────────────

def extract_text_from_pdf(file_path: str) -> dict:
    """Extract text from a PDF file.

    Returns a dict with:
      - pages: list of {page_number, text, is_scanned}
      - total_pages: int
      - is_text_pdf: bool (True if most pages have extractable text)
      - full_text: str
    """
    doc = fitz.open(file_path)
    pages = []
    text_page_count = 0

    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text("text").strip()
        is_scanned = len(text) < 50  # Very little text = likely scanned

        if text and len(text) >= 50:
            text_page_count += 1

        pages.append({
            "page_number": page_num + 1,
            "text": text,
            "is_scanned": is_scanned,
        })

    doc.close()

    is_text_pdf = text_page_count >= len(pages) * 0.5
    full_text = "\n\n".join(
        f"--- Page {p['page_number']} ---\n{p['text']}"
        for p in pages if p["text"]
    )

    return {
        "pages": pages,
        "total_pages": len(pages),
        "is_text_pdf": is_text_pdf,
        "full_text": full_text,
    }


def extract_text_from_docx(file_path: str) -> dict:
    """Extract text from a DOCX file."""
    import docx
    doc = docx.Document(file_path)
    paragraphs = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if text:
            paragraphs.append(text)

    full_text = "\n\n".join(paragraphs)
    return {
        "pages": [{"page_number": 1, "text": full_text, "is_scanned": False}],
        "total_pages": 1,
        "is_text_pdf": True,
        "full_text": full_text,
    }


def extract_text_from_txt(file_path: str) -> dict:
    """Extract text from a plain text file."""
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    return {
        "pages": [{"page_number": 1, "text": text, "is_scanned": False}],
        "total_pages": 1,
        "is_text_pdf": True,
        "full_text": text,
    }


def render_pdf_page_to_image(file_path: str, page_num: int, dpi: int = 200) -> np.ndarray:
    """Render a single PDF page to a numpy image array."""
    doc = fitz.open(file_path)
    page = doc[page_num]
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat)
    img_bytes = pix.tobytes("png")
    doc.close()
    return bytes_to_image(img_bytes)


def render_all_pdf_pages(file_path: str, dpi: int = 200) -> list[np.ndarray]:
    """Render all pages of a PDF to image arrays."""
    doc = fitz.open(file_path)
    images = []
    for page_num in range(len(doc)):
        page = doc[page_num]
        zoom = dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)
        img_bytes = pix.tobytes("png")
        images.append(bytes_to_image(img_bytes))
    doc.close()
    return images


# ── Gemini-based OCR ────────────────────────────────────────────

async def ocr_image_with_gemini(
    image_data: bytes,
    mime_type: str = "image/png",
    language: str = "en",
) -> dict:
    """Use Gemini multimodal to extract text from a document image.

    Returns dict with:
      - text: str (extracted text)
      - confidence: str (high/medium/low)
      - unclear_portions: list[str]
      - document_structure: dict (headings, paragraphs, tables detected)
    """
    import httpx

    api_key = os.getenv("GOOGLE_API_KEY", "").strip()
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()

    b64 = base64.b64encode(image_data).decode("utf-8")

    prompt = """You are performing OCR (Optical Character Recognition) on a document image.

Your task is to extract ALL readable text from this document image as accurately as possible.

Instructions:
1. Extract every piece of readable text, preserving the original structure (headings, paragraphs, lists, tables).
2. Maintain the reading order (top to bottom, left to right).
3. Preserve original formatting where possible (indentation, numbering, bullet points).
4. For text that is unclear, partially visible, or cannot be confidently read, mark it as [UNCLEAR] or [ILLEGIBLE].
5. Do NOT guess or fabricate text that you cannot read.
6. Preserve important legal terms, names, dates, amounts, and numbers exactly as they appear.
7. If you see signatures, stamps, or seals, note their location as [SIGNATURE], [STAMP], or [SEAL].

Return ONLY a valid JSON object with these keys:
"text" (string — the complete extracted text with structure preserved)
"confidence" (string — "high", "medium", or "low" — your overall confidence in the extraction)
"unclear_portions" (array of strings — descriptions of parts that could not be clearly read)
"has_handwriting" (boolean — whether handwritten content was detected)
"has_tables" (boolean — whether table structures were detected)
"has_signatures" (boolean — whether signatures/stamps were detected)
"language_detected" (string — the primary language of the document text)
"""

    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": mime_type, "data": b64}},
            ],
        }],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 8192,
        },
    }

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(url, json=body)

    if response.status_code >= 400:
        raise RuntimeError(f"Gemini OCR failed ({response.status_code}): {response.text[:300]}")

    data = response.json()
    raw_text = ""
    for candidate in data.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            if "text" in part:
                raw_text += part["text"]

    return _parse_ocr_result(raw_text)


def _parse_ocr_result(raw: str) -> dict:
    """Parse the OCR JSON result from Gemini."""
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    candidate = (fenced.group(1) if fenced else raw).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")

    defaults = {
        "text": "",
        "confidence": "low",
        "unclear_portions": [],
        "has_handwriting": False,
        "has_tables": False,
        "has_signatures": False,
        "language_detected": "unknown",
    }

    if start == -1 or end == -1:
        # The model returned plain text instead of JSON
        return {**defaults, "text": raw.strip()}

    try:
        parsed = json.loads(candidate[start:end + 1])
        return {
            "text": str(parsed.get("text", "")),
            "confidence": str(parsed.get("confidence", "medium")),
            "unclear_portions": [str(u) for u in parsed.get("unclear_portions", [])],
            "has_handwriting": bool(parsed.get("has_handwriting", False)),
            "has_tables": bool(parsed.get("has_tables", False)),
            "has_signatures": bool(parsed.get("has_signatures", False)),
            "language_detected": str(parsed.get("language_detected", "unknown")),
        }
    except (json.JSONDecodeError, ValueError):
        return {**defaults, "text": raw.strip()}


# ── Full OCR pipeline ───────────────────────────────────────────

async def extract_text_from_image(
    file_path: str,
    mime_type: str,
    enhance_first: bool = True,
) -> dict:
    """Full OCR pipeline for a single image file.

    Returns:
      - original_ocr: OCR result on the original image
      - enhanced_ocr: OCR result on the enhanced image (if different)
      - best_text: the most reliable extracted text
      - enhancements_applied: list of image operations
      - quality_assessment: image quality metrics
    """
    from document_image_processing import assess_image_quality

    img = load_image(file_path)
    quality = assess_image_quality(img)

    # OCR on original
    orig_bytes = image_to_bytes(img, ".png")
    original_ocr = await ocr_image_with_gemini(orig_bytes, "image/png")

    enhanced_ocr = None
    enhancements = []

    if enhance_first:
        enhanced_img, enhancements = auto_enhance(img)
        enhanced_bytes = image_to_bytes(enhanced_img, ".png")

        # Only run OCR again if we actually enhanced something meaningful
        if enhancements and enhancements != ["Mild contrast and sharpness tuning"]:
            enhanced_ocr = await ocr_image_with_gemini(enhanced_bytes, "image/png")

    # Determine best text
    best_text = original_ocr["text"]
    if enhanced_ocr and enhanced_ocr["text"]:
        # Prefer the version with more text and higher confidence
        orig_len = len(original_ocr["text"])
        enhanced_len = len(enhanced_ocr["text"])
        orig_conf = {"high": 3, "medium": 2, "low": 1}.get(original_ocr["confidence"], 0)
        enh_conf = {"high": 3, "medium": 2, "low": 1}.get(enhanced_ocr["confidence"], 0)

        if enh_conf > orig_conf or (enh_conf == orig_conf and enhanced_len > orig_len * 1.1):
            best_text = enhanced_ocr["text"]

    return {
        "original_ocr": original_ocr,
        "enhanced_ocr": enhanced_ocr,
        "best_text": best_text,
        "enhancements_applied": enhancements,
        "quality_assessment": quality,
    }


async def extract_text_from_scanned_pdf(
    file_path: str,
    max_pages: int = 20,
) -> dict:
    """OCR pipeline for scanned PDF documents.

    Renders each page to an image, enhances it, then runs Gemini OCR.
    """
    doc = fitz.open(file_path)
    total_pages = min(len(doc), max_pages)
    doc.close()

    pages = []
    full_text_parts = []
    all_unclear = []
    overall_confidence = "high"

    for page_num in range(total_pages):
        print(f"[ocr] Processing page {page_num + 1}/{total_pages}...")
        img = render_pdf_page_to_image(file_path, page_num, dpi=200)

        # Enhance the page image
        enhanced_img, enhancements = auto_enhance(img)
        enhanced_bytes = image_to_bytes(enhanced_img, ".png")

        # Run OCR
        ocr_result = await ocr_image_with_gemini(enhanced_bytes, "image/png")

        pages.append({
            "page_number": page_num + 1,
            "text": ocr_result["text"],
            "confidence": ocr_result["confidence"],
            "unclear_portions": ocr_result["unclear_portions"],
            "enhancements_applied": enhancements,
            "is_scanned": True,
        })

        if ocr_result["text"]:
            full_text_parts.append(
                f"--- Page {page_num + 1} ---\n{ocr_result['text']}"
            )
        all_unclear.extend(ocr_result["unclear_portions"])

        # Track worst confidence
        conf_order = {"high": 3, "medium": 2, "low": 1}
        if conf_order.get(ocr_result["confidence"], 0) < conf_order.get(overall_confidence, 3):
            overall_confidence = ocr_result["confidence"]

    return {
        "pages": pages,
        "total_pages": total_pages,
        "full_text": "\n\n".join(full_text_parts),
        "overall_confidence": overall_confidence,
        "unclear_portions": all_unclear,
        "is_text_pdf": False,
    }


# ── Unified extraction entry point ──────────────────────────────

async def extract_document_text(file_path: str, mime_type: str) -> dict:
    """Unified document text extraction.

    Automatically selects the best extraction strategy based on file type.
    """
    path = Path(file_path)

    if mime_type == "text/plain" or path.suffix.lower() == ".txt":
        return extract_text_from_txt(file_path)

    if mime_type in (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
    ) or path.suffix.lower() in (".docx", ".doc"):
        return extract_text_from_docx(file_path)

    if mime_type == "application/pdf" or path.suffix.lower() == ".pdf":
        # First try direct text extraction
        result = extract_text_from_pdf(file_path)
        if result["is_text_pdf"] and len(result["full_text"]) > 100:
            return result
        # Fall back to OCR for scanned PDFs
        print(f"[ocr] PDF appears to be scanned, using Gemini OCR...")
        return await extract_text_from_scanned_pdf(file_path)

    if mime_type.startswith("image/") or path.suffix.lower() in (
        ".png", ".jpg", ".jpeg", ".tiff", ".bmp", ".gif", ".webp",
    ):
        result = await extract_text_from_image(file_path, mime_type)
        return {
            "pages": [{"page_number": 1, "text": result["best_text"], "is_scanned": True}],
            "total_pages": 1,
            "is_text_pdf": False,
            "full_text": result["best_text"],
            "quality_assessment": result["quality_assessment"],
            "enhancements_applied": result["enhancements_applied"],
            "original_ocr": result["original_ocr"],
            "enhanced_ocr": result["enhanced_ocr"],
        }

    raise ValueError(f"Unsupported file type: {mime_type}")

