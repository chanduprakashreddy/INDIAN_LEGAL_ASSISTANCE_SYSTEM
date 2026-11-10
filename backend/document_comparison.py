"""Document comparison service.

Compares two document versions and identifies differences in:
  - Text content (added, removed, modified)
  - Key legal elements (dates, amounts, parties, obligations)
  - Structural changes

Uses Python difflib for text comparison and LLM for semantic analysis
of important changes.
"""

from __future__ import annotations

import difflib
import re
from typing import Optional

from llm import complete_text
from document_ocr import extract_document_text


async def compare_documents(
    file_path_1: str,
    mime_type_1: str,
    file_path_2: str,
    mime_type_2: str,
    language: str = "en",
) -> dict:
    """Compare two documents and return a structured comparison report.

    Returns:
      - text_diff: line-by-line differences
      - semantic_analysis: LLM analysis of important changes
      - statistics: counts of additions, deletions, modifications
    """
    # Extract text from both documents
    text1_result = await extract_document_text(file_path_1, mime_type_1)
    text2_result = await extract_document_text(file_path_2, mime_type_2)

    text1 = text1_result.get("full_text", "")
    text2 = text2_result.get("full_text", "")

    if not text1.strip():
        return {"error": "Could not extract text from the first document."}
    if not text2.strip():
        return {"error": "Could not extract text from the second document."}

    # Line-by-line diff
    lines1 = text1.splitlines()
    lines2 = text2.splitlines()

    diff = list(difflib.unified_diff(
        lines1, lines2,
        fromfile="Document 1",
        tofile="Document 2",
        lineterm="",
    ))

    # Compute statistics
    added = sum(1 for line in diff if line.startswith("+") and not line.startswith("+++"))
    removed = sum(1 for line in diff if line.startswith("-") and not line.startswith("---"))
    unchanged = sum(1 for line in diff if line.startswith(" "))

    # Identify specific changes
    changes = _extract_changes(lines1, lines2)

    # Semantic analysis of important changes via LLM
    semantic = await _analyse_changes_semantically(
        text1, text2, changes, language,
    )

    # Similarity ratio
    matcher = difflib.SequenceMatcher(None, text1, text2)
    similarity = round(matcher.ratio() * 100, 1)

    return {
        "similarity_percentage": similarity,
        "statistics": {
            "lines_added": added,
            "lines_removed": removed,
            "lines_unchanged": unchanged,
            "total_lines_doc1": len(lines1),
            "total_lines_doc2": len(lines2),
        },
        "text_diff": "\n".join(diff[:500]),  # Limit for display
        "changes": changes,
        "semantic_analysis": semantic,
        "doc1_text": text1[:2000],
        "doc2_text": text2[:2000],
    }


def _extract_changes(lines1: list[str], lines2: list[str]) -> list[dict]:
    """Extract structured change descriptions from two document versions."""
    matcher = difflib.SequenceMatcher(None, lines1, lines2)
    changes = []

    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        if op == "equal":
            continue

        original = "\n".join(lines1[i1:i2]).strip()
        modified = "\n".join(lines2[j1:j2]).strip()

        change_type = "modified"
        if op == "insert":
            change_type = "added"
        elif op == "delete":
            change_type = "removed"
        elif op == "replace":
            change_type = "modified"

        # Try to categorize the change
        category = _categorize_change(original, modified)

        changes.append({
            "type": change_type,
            "category": category,
            "location": f"Lines {i1 + 1}-{i2}" if original else f"After line {i1}",
            "original": original[:500] if original else "",
            "modified": modified[:500] if modified else "",
        })

    return changes[:50]  # Limit number of changes


def _categorize_change(original: str, modified: str) -> str:
    """Categorize a change based on its content."""
    combined = (original + " " + modified).lower()

    if any(word in combined for word in ("rs.", "₹", "rupee", "amount", "price", "cost", "fee")):
        return "amount_change"
    if any(word in combined for word in ("date", "dated", "day of", "month", "year")):
        return "date_change"
    if any(word in combined for word in ("party", "parties", "between", "hereinafter")):
        return "party_change"
    if any(word in combined for word in ("shall", "must", "obligat", "require", "duty")):
        return "obligation_change"
    if any(word in combined for word in ("terminat", "cancel", "revoke", "end")):
        return "termination_change"
    if any(word in combined for word in ("clause", "section", "article", "provision")):
        return "clause_change"

    # Check if it's just formatting
    if original.strip().replace(" ", "") == modified.strip().replace(" ", ""):
        return "formatting_only"

    return "content_change"


async def _analyse_changes_semantically(
    text1: str,
    text2: str,
    changes: list[dict],
    language: str,
) -> dict:
    """Use LLM to identify legally significant changes."""
    from prompts import language_label
    lang = language_label(language)

    # Build a summary of changes for the LLM
    change_summary = ""
    for i, ch in enumerate(changes[:20], 1):
        change_summary += f"\n{i}. [{ch['type'].upper()}] ({ch['category']})\n"
        if ch["original"]:
            change_summary += f"   Original: {ch['original'][:200]}\n"
        if ch["modified"]:
            change_summary += f"   Modified: {ch['modified'][:200]}\n"

    if not change_summary.strip():
        return {
            "summary": "The two documents appear to be identical or nearly identical.",
            "significant_changes": [],
            "risk_assessment": "No significant changes detected.",
        }

    messages = [
        {"role": "system", "content": (
            "You are a legal document comparison analyst. Analyse the differences "
            "between two versions of a document and identify legally significant changes.\n\n"
            "For each significant change, explain:\n"
            "1. What was changed\n"
            "2. Why it matters legally\n"
            "3. Potential implications\n\n"
            "Distinguish between:\n"
            "- Formatting-only changes (low significance)\n"
            "- Meaning-changing modifications (high significance)\n"
            "- Changes to dates, amounts, parties (high significance)\n"
            "- Changes to obligations and conditions (high significance)\n\n"
            "Return ONLY a valid JSON with:\n"
            '"summary" (string — brief overall comparison summary)\n'
            '"significant_changes" (array of objects with: "description", '
            '"significance" (low/medium/high), "implication")\n'
            '"risk_assessment" (string — overall risk assessment of the changes)\n'
        )},
        {"role": "user", "content": (
            f"Compare these document versions ({lang}):\n\n"
            f"DOCUMENT 1 (first 2000 chars):\n{text1[:2000]}\n\n"
            f"DOCUMENT 2 (first 2000 chars):\n{text2[:2000]}\n\n"
            f"DETECTED CHANGES:\n{change_summary}"
        )},
    ]

    raw = await complete_text(messages)
    return _parse_comparison_result(raw)


def _parse_comparison_result(raw: str) -> dict:
    """Parse comparison analysis JSON from LLM."""
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    candidate = (fenced.group(1) if fenced else raw).strip()
    start = candidate.find("{")
    end = candidate.rfind("}")

    defaults = {
        "summary": raw[:500] if raw else "Analysis unavailable.",
        "significant_changes": [],
        "risk_assessment": "Could not assess.",
    }

    if start == -1 or end == -1:
        return defaults

    try:
        parsed = json.loads(candidate[start:end + 1])
        return {
            "summary": str(parsed.get("summary", "")),
            "significant_changes": [
                {
                    "description": str(c.get("description", "")),
                    "significance": str(c.get("significance", "low")),
                    "implication": str(c.get("implication", "")),
                }
                for c in parsed.get("significant_changes", [])
                if isinstance(c, dict)
            ],
            "risk_assessment": str(parsed.get("risk_assessment", "")),
        }
    except (json.JSONDecodeError, ValueError):
        return defaults


import json

