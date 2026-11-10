"""Document authenticity and fake-document detection service.

Analyses documents for signs of manipulation or forgery through:
  1. Metadata analysis (PDF properties, creation/modification dates)
  2. Structural analysis (PDF structure, embedded objects)
  3. Textual analysis (inconsistencies, language patterns)
  4. Visual analysis (via Gemini multimodal — fonts, alignment, stamps)

Important: This module NEVER declares a definitive "Genuine" or "Fake"
verdict.  It reports observed indicators and recommends verification steps.
"""

from __future__ import annotations

import base64
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF

from llm import complete_text


# ── 1. PDF Metadata Analysis ────────────────────────────────────

def analyse_pdf_metadata(file_path: str) -> dict:
    """Extract and analyse PDF metadata for suspicious indicators."""
    try:
        doc = fitz.open(file_path)
    except Exception as e:
        return {"error": f"Could not open PDF: {e}", "findings": []}

    meta = doc.metadata or {}
    findings = []
    metadata_info = {}

    # Extract standard metadata
    for key in ("title", "author", "subject", "keywords", "creator",
                "producer", "creationDate", "modDate", "format"):
        val = meta.get(key, "")
        if val:
            metadata_info[key] = val

    metadata_info["page_count"] = len(doc)
    metadata_info["is_encrypted"] = doc.is_encrypted

    # Analyse for suspicious patterns
    creator = meta.get("creator", "")
    producer = meta.get("producer", "")
    creation_date = meta.get("creationDate", "")
    mod_date = meta.get("modDate", "")

    # Check for editing software
    editing_tools = [
        "photoshop", "gimp", "inkscape", "illustrator",
        "paint", "canva", "foxit editor", "nitro",
    ]
    for tool in editing_tools:
        if tool in creator.lower() or tool in producer.lower():
            findings.append({
                "type": "metadata",
                "severity": "medium",
                "title": "Image/design editing software detected",
                "detail": f"The document was created or modified with '{creator or producer}', "
                          "which is typically used for image editing rather than document creation.",
                "recommendation": "Verify the document's origin with the issuing authority.",
            })

    # Check date consistency
    if creation_date and mod_date:
        try:
            c_date = _parse_pdf_date(creation_date)
            m_date = _parse_pdf_date(mod_date)
            if c_date and m_date:
                if m_date < c_date:
                    findings.append({
                        "type": "metadata",
                        "severity": "high",
                        "title": "Modification date precedes creation date",
                        "detail": f"Creation: {c_date}, Modified: {m_date}. "
                                  "This is unusual and may indicate metadata tampering.",
                        "recommendation": "Request the original document from the issuer.",
                    })
                diff = abs((m_date - c_date).days)
                if diff > 365 * 5:
                    findings.append({
                        "type": "metadata",
                        "severity": "low",
                        "title": "Large gap between creation and modification dates",
                        "detail": f"The document was modified {diff} days after creation. "
                                  "While not necessarily suspicious, it merits verification.",
                        "recommendation": "Confirm the document version with the issuing party.",
                    })
        except Exception:
            pass

    # Check for missing metadata (unusual for legitimate documents)
    if not creator and not producer:
        findings.append({
            "type": "metadata",
            "severity": "low",
            "title": "No creator or producer metadata",
            "detail": "The document lacks standard creation metadata. "
                      "Some legitimate documents may strip this, but it can also "
                      "indicate manual construction.",
            "recommendation": "Not necessarily suspicious; verify through other means.",
        })

    doc.close()

    return {
        "metadata": metadata_info,
        "findings": findings,
    }


def _parse_pdf_date(date_str: str) -> Optional[datetime]:
    """Parse PDF date format (D:YYYYMMDDHHmmSS...)."""
    if not date_str:
        return None
    # Remove D: prefix and timezone
    clean = date_str.replace("D:", "").split("+")[0].split("-")[0].split("Z")[0]
    for fmt in ("%Y%m%d%H%M%S", "%Y%m%d%H%M", "%Y%m%d"):
        try:
            return datetime.strptime(clean[:len(fmt.replace("%", ""))], fmt)
        except (ValueError, IndexError):
            continue
    return None


# ── 2. PDF Structural Analysis ──────────────────────────────────

def analyse_pdf_structure(file_path: str) -> dict:
    """Analyse PDF structure for suspicious elements."""
    try:
        doc = fitz.open(file_path)
    except Exception as e:
        return {"error": str(e), "findings": []}

    findings = []
    structure_info = {
        "page_count": len(doc),
        "has_annotations": False,
        "has_embedded_files": False,
        "has_javascript": False,
        "has_forms": False,
        "font_count": 0,
        "image_count": 0,
        "fonts_used": [],
    }

    all_fonts = set()
    total_images = 0

    for page_num in range(len(doc)):
        page = doc[page_num]

        # Check fonts
        fonts = page.get_fonts()
        for font in fonts:
            font_name = font[3] if len(font) > 3 else "Unknown"
            all_fonts.add(font_name)

        # Check images
        images = page.get_images()
        total_images += len(images)

        # Check annotations
        annots = page.annots()
        if annots:
            structure_info["has_annotations"] = True
            for annot in annots:
                if annot.type[0] in (8, 9):  # FileAttachment, Sound
                    findings.append({
                        "type": "structural",
                        "severity": "medium",
                        "title": f"Unusual annotation on page {page_num + 1}",
                        "detail": f"Found annotation type: {annot.type[1]}",
                        "recommendation": "Review the annotation content.",
                    })

    structure_info["fonts_used"] = sorted(all_fonts)
    structure_info["font_count"] = len(all_fonts)
    structure_info["image_count"] = total_images

    # Flag many different fonts (unusual for official documents)
    if len(all_fonts) > 8:
        findings.append({
            "type": "structural",
            "severity": "low",
            "title": "Unusually many different fonts",
            "detail": f"The document uses {len(all_fonts)} different fonts. "
                      "Official documents typically use 2-4 fonts.",
            "recommendation": "Compare with known genuine documents from the same source.",
        })

    # Check for JavaScript
    try:
        catalog = doc.pdf_catalog()
        if catalog:
            xref_count = doc.xref_length()
            for xref in range(1, min(xref_count, 500)):
                try:
                    obj = doc.xref_object(xref)
                    if "/JavaScript" in obj or "/JS " in obj:
                        structure_info["has_javascript"] = True
                        findings.append({
                            "type": "structural",
                            "severity": "high",
                            "title": "JavaScript detected in document",
                            "detail": "The PDF contains embedded JavaScript code, "
                                      "which is unusual for legal documents and can be "
                                      "a sign of a malicious or modified file.",
                            "recommendation": "Exercise extreme caution. "
                                              "Do not enable JavaScript execution.",
                        })
                        break
                except Exception:
                    continue
    except Exception:
        pass

    doc.close()

    return {
        "structure": structure_info,
        "findings": findings,
    }


# ── 3. Textual Analysis (LLM-based) ─────────────────────────────

async def analyse_text_consistency(text: str, language: str = "en") -> dict:
    """Use LLM to check document text for suspicious patterns."""
    if not text or len(text.strip()) < 50:
        return {"findings": [], "note": "Insufficient text for analysis."}

    from prompts import language_label
    lang = language_label(language)

    messages = [
        {"role": "system", "content": (
            "You are a forensic document analyst specializing in Indian legal documents. "
            "Analyse the following document text for signs of possible manipulation, "
            "inconsistency, or forgery.\n\n"
            "Check for:\n"
            "1. Inconsistent terminology (different terms for the same concept)\n"
            "2. Unusual language patterns (mix of formal/informal, inconsistent style)\n"
            "3. Contradictory details (conflicting dates, amounts, names)\n"
            "4. Incorrect or suspicious formatting patterns\n"
            "5. Inconsistent names, dates, amounts, or identification details\n"
            "6. Incorrect legal references or non-existent provisions\n"
            "7. Unusual clause ordering for the document type\n"
            "8. Missing standard elements expected in this document type\n\n"
            "IMPORTANT RULES:\n"
            "- Report OBSERVATIONS, not conclusions\n"
            "- Do NOT declare the document 'fake' or 'genuine'\n"
            "- Unusual formatting is NOT proof of fraud\n"
            "- Some inconsistencies may be legitimate errors or informal drafting\n"
            "- Be balanced and fair\n\n"
            "Return ONLY a valid JSON object with:\n"
            '"findings" (array of objects, each with: "title", "detail", "severity" '
            '(low/medium/high), "recommendation")\n'
            '"overall_text_quality" (string — "consistent", "mostly_consistent", '
            '"some_inconsistencies", "notable_inconsistencies")\n'
            '"document_type_detected" (string)\n'
        )},
        {"role": "user", "content": (
            f"Analyse this document text ({lang}):\n\n{text[:8000]}"
        )},
    ]

    raw = await complete_text(messages)
    return _parse_analysis_findings(raw)


def _parse_analysis_findings(raw: str) -> dict:
    """Parse analysis findings JSON from LLM."""
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    candidate = (fenced.group(1) if fenced else raw).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")

    defaults = {
        "findings": [],
        "overall_text_quality": "unknown",
        "document_type_detected": "unknown",
    }

    if start == -1 or end == -1:
        return defaults

    try:
        parsed = json.loads(candidate[start:end + 1])
        findings = []
        for f in parsed.get("findings", []):
            if isinstance(f, dict):
                findings.append({
                    "type": "textual",
                    "title": str(f.get("title", "")),
                    "detail": str(f.get("detail", "")),
                    "severity": str(f.get("severity", "low")),
                    "recommendation": str(f.get("recommendation", "")),
                })
        return {
            "findings": findings,
            "overall_text_quality": str(parsed.get("overall_text_quality", "unknown")),
            "document_type_detected": str(parsed.get("document_type_detected", "unknown")),
        }
    except (json.JSONDecodeError, ValueError):
        return defaults


# ── 4. Visual Analysis (Gemini multimodal) ──────────────────────

async def analyse_visual_authenticity(
    file_path: str,
    mime_type: str,
) -> dict:
    """Use Gemini's vision model to check for visual signs of manipulation."""
    import httpx

    api_key = os.getenv("GOOGLE_API_KEY", "").strip()
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash").strip()

    with open(file_path, "rb") as f:
        file_bytes = f.read()
    b64 = base64.b64encode(file_bytes).decode("utf-8")

    prompt = """You are a forensic document analyst examining this document image for visual authenticity indicators.

Analyse the document for:
1. Visible signs of image editing or pasting
2. Inconsistent fonts or text sizes
3. Misaligned text or elements
4. Unusual signature or stamp placement
5. Signs of text being added or removed
6. Inconsistent lighting or shadows on text
7. Digital artifacts around text or images
8. Inconsistent resolution across different parts
9. Signs of physical tampering (erasure, overwriting)

IMPORTANT:
- Report only VISUAL OBSERVATIONS
- Do NOT declare the document fake or genuine
- Some visual irregularities may be from scanning or printing quality
- Not finding signs of tampering does NOT prove authenticity

Return ONLY a valid JSON object with:
"findings" (array of objects with: "title", "detail", "severity" (low/medium/high), "recommendation")
"overall_visual_quality" (string — "clean", "minor_irregularities", "notable_irregularities")
"has_visible_signatures" (boolean)
"has_visible_stamps" (boolean)
"has_visible_seals" (boolean)
"""

    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": mime_type, "data": b64}},
            ],
        }],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096},
    }

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(url, json=body)

    if response.status_code >= 400:
        return {"findings": [], "error": f"Visual analysis failed: {response.status_code}"}

    data = response.json()
    raw_text = ""
    for candidate in data.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            if "text" in part:
                raw_text += part["text"]

    return _parse_visual_findings(raw_text)


def _parse_visual_findings(raw: str) -> dict:
    """Parse visual analysis JSON from Gemini."""
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    candidate = (fenced.group(1) if fenced else raw).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")

    defaults = {
        "findings": [],
        "overall_visual_quality": "unknown",
        "has_visible_signatures": False,
        "has_visible_stamps": False,
        "has_visible_seals": False,
    }

    if start == -1 or end == -1:
        return defaults

    try:
        parsed = json.loads(candidate[start:end + 1])
        findings = []
        for f in parsed.get("findings", []):
            if isinstance(f, dict):
                findings.append({
                    "type": "visual",
                    "title": str(f.get("title", "")),
                    "detail": str(f.get("detail", "")),
                    "severity": str(f.get("severity", "low")),
                    "recommendation": str(f.get("recommendation", "")),
                })
        return {
            "findings": findings,
            "overall_visual_quality": str(parsed.get("overall_visual_quality", "unknown")),
            "has_visible_signatures": bool(parsed.get("has_visible_signatures", False)),
            "has_visible_stamps": bool(parsed.get("has_visible_stamps", False)),
            "has_visible_seals": bool(parsed.get("has_visible_seals", False)),
        }
    except (json.JSONDecodeError, ValueError):
        return defaults


# ── Main Authenticity Assessment ────────────────────────────────

async def assess_authenticity(
    file_path: str,
    mime_type: str,
    language: str = "en",
    document_text: Optional[str] = None,
) -> dict:
    """Comprehensive document authenticity assessment.

    Combines metadata, structural, textual, and visual analysis.
    Always uses the ORIGINAL document, never an enhanced copy.
    """
    path = Path(file_path)
    is_pdf = mime_type == "application/pdf" or path.suffix.lower() == ".pdf"

    all_findings = []
    assessment = {
        "metadata_analysis": None,
        "structural_analysis": None,
        "textual_analysis": None,
        "visual_analysis": None,
        "overall_assessment": "",
        "confidence_level": "",
        "all_findings": [],
        "recommended_verification": [],
        "limitations": [],
    }

    # 1. Metadata analysis (PDF only)
    if is_pdf:
        meta_result = analyse_pdf_metadata(file_path)
        assessment["metadata_analysis"] = meta_result
        all_findings.extend(meta_result.get("findings", []))

        struct_result = analyse_pdf_structure(file_path)
        assessment["structural_analysis"] = struct_result
        all_findings.extend(struct_result.get("findings", []))

    # 2. Textual analysis
    if document_text and len(document_text.strip()) > 50:
        text_result = await analyse_text_consistency(document_text, language)
        assessment["textual_analysis"] = text_result
        all_findings.extend(text_result.get("findings", []))

    # 3. Visual analysis (for images and PDFs)
    if is_pdf or mime_type.startswith("image/"):
        visual_result = await analyse_visual_authenticity(file_path, mime_type)
        assessment["visual_analysis"] = visual_result
        all_findings.extend(visual_result.get("findings", []))

    # Compile overall assessment
    assessment["all_findings"] = all_findings

    high_count = sum(1 for f in all_findings if f.get("severity") == "high")
    medium_count = sum(1 for f in all_findings if f.get("severity") == "medium")

    if high_count >= 2:
        assessment["overall_assessment"] = "Significant signs of possible modification detected"
        assessment["confidence_level"] = "Notable concern"
    elif high_count == 1 or medium_count >= 3:
        assessment["overall_assessment"] = "Some potentially suspicious indicators detected"
        assessment["confidence_level"] = "Moderate concern"
    elif medium_count >= 1:
        assessment["overall_assessment"] = "Minor observations noted; may warrant verification"
        assessment["confidence_level"] = "Low concern"
    elif len(all_findings) == 0:
        assessment["overall_assessment"] = "No obvious suspicious indicators detected"
        assessment["confidence_level"] = "No automated concerns"
    else:
        assessment["overall_assessment"] = "Minor observations only"
        assessment["confidence_level"] = "Minimal concern"

    # Standard limitations
    assessment["limitations"] = [
        "Automated analysis cannot conclusively authenticate any document.",
        "Genuine-looking metadata can be manipulated.",
        "Unusual formatting alone is not proof of fraud.",
        "This analysis examines available digital evidence only.",
        "For official verification, contact the issuing authority directly.",
        "A clean automated report does NOT guarantee authenticity.",
    ]

    # Recommended verification steps
    assessment["recommended_verification"] = [
        "Contact the issuing authority or institution to verify the document.",
        "Compare with other known genuine documents from the same source.",
        "If significant amounts or legal rights depend on this document, "
        "have it examined by a certified forensic document examiner.",
    ]

    return assessment

