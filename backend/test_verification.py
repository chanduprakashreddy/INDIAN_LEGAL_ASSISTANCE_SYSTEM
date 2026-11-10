"""Offline-only verification tests - no network, no LLM calls."""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# --- Test 1: Intent Classification (purely local, no network) ---
async def test_intents():
    from llm import classify_query
    print("--- 1. Intent Classification ---")
    cases = [
        ("Can you restore this old faded agreement?", "document_restore"),
        ("Enhance this to make it professional", "document_enhance"),
        ("Check if this is authentic or fake", "document_authenticity"),
        ("Compare these two documents", "document_compare"),
        ("Summarize the key points of this notice", "document_summarize"),
        ("Draft a legal notice for non-payment", "document_generate"),
        ("My employer has not paid my salary", "personal_case"),
        ("What is Section 420 of IPC?", "general_legal"),
    ]
    passed = 0
    for text, expected in cases:
        actual = await classify_query(text)
        ok = actual == expected
        print(f"  [{'PASS' if ok else 'FAIL'}] {text[:42]:42s} -> {actual:22s} (expect {expected})")
        if ok:
            passed += 1
    print(f"  Result: {passed}/{len(cases)} passed")
    return passed == len(cases)

# --- Test 2: Image Processing (purely local with OpenCV/Pillow) ---
def test_image_processing():
    import numpy as np
    import cv2
    from document_image_processing import assess_image_quality, auto_enhance
    print("\n--- 2. Image Processing ---")
    img = np.ones((300, 500, 3), dtype=np.uint8) * 200
    cv2.putText(img, "LEGAL NOTICE", (60, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (20, 20, 20), 2)
    cv2.putText(img, "To: Respondent", (60, 160), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (40, 40, 40), 1)
    try:
        q = assess_image_quality(img)
        print(f"  Quality: sharpness={q.get('sharpness_laplacian'):.1f}, brightness={q.get('mean_brightness'):.1f}, contrast={q.get('contrast_std'):.1f}")
        assert "sharpness_laplacian" in q and "mean_brightness" in q and "contrast_std" in q, "Missing quality keys"
        enhanced_img, improvements = auto_enhance(img)
        assert isinstance(enhanced_img, np.ndarray), "Enhanced result must be numpy array"
        print(f"  Improvements: {improvements}")
        print("  [PASS] Image processing pipeline works")
        return True
    except Exception as e:
        print(f"  [FAIL] {e}")
        return False

# --- Test 3: Text Extraction (purely local) ---
async def test_text_extraction():
    from document_ocr import extract_document_text
    print("\n--- 3. Text Extraction ---")
    txt_path = str(Path(__file__).parent / "test_extract.txt")
    Path(txt_path).write_text(
        "LEGAL NOTICE\nUnder Section 138 of Negotiable Instruments Act\nDemand: Rs 50,000",
        encoding="utf-8",
    )
    try:
        res = await extract_document_text(txt_path, "text/plain")
        text = res["full_text"]
        assert "Section 138" in text, f"Expected 'Section 138' in extracted text"
        print(f"  Extracted: {text[:60].replace(chr(10), ' ')}...")
        print("  [PASS] Text extraction works")
        return True
    except Exception as e:
        print(f"  [FAIL] {e}")
        return False
    finally:
        if os.path.exists(txt_path):
            os.unlink(txt_path)

# --- Test 4: Pydantic Models (import check) ---
def test_models():
    from models import (
        DocumentEnhanceRequest, DocumentRestoreRequest,
        DocumentAuthenticityRequest, DocumentCompareRequest,
        DocumentSummarizeRequest, DocumentQARequest,
    )
    print("\n--- 4. Pydantic Models ---")
    try:
        r = DocumentEnhanceRequest(sessionId="abc", documentId="xyz", mode="legal")
        assert r.sessionId == "abc" and r.mode == "legal"
        r2 = DocumentCompareRequest(sessionId="s1", documentId1="d1", documentId2="d2")
        assert r2.documentId1 == "d1"
        r3 = DocumentQARequest(sessionId="s1", documentId="d1", question="What is the rent?")
        assert r3.question == "What is the rent?"
        print("  [PASS] All new models validate correctly")
        return True
    except Exception as e:
        print(f"  [FAIL] {e}")
        return False

# --- Test 5: FastAPI Route Registration ---
def test_routes():
    from main import app
    print("\n--- 5. Route Registration ---")
    routes = [r.path for r in app.routes]
    expected = [
        "/api/document-intelligence/enhance",
        "/api/document-intelligence/restore",
        "/api/document-intelligence/authenticity",
        "/api/document-intelligence/compare",
        "/api/document-intelligence/summarize",
        "/api/document-intelligence/qa",
        "/api/document-intelligence/enhanced/{filename}",
    ]
    all_ok = True
    for ep in expected:
        ok = ep in routes
        print(f"  [{'PASS' if ok else 'FAIL'}] {ep}")
        if not ok:
            all_ok = False
    return all_ok

# --- Test 6: Difflib-based comparison (no LLM, just the structural diff) ---
def test_diff_logic():
    print("\n--- 6. Diff Logic (no LLM) ---")
    from document_comparison import _extract_changes
    text1 = "The rent is Rs 15,000 per month.\nThe agreement is for 11 months."
    text2 = "The rent is Rs 20,000 per month.\nThe agreement is for 24 months.\nA lock-in period of 12 months applies."
    changes = _extract_changes(text1, text2)
    print(f"  Changes detected: {len(changes)}")
    for c in changes[:5]:
        print(f"    {c.get('type','?'):10s} | {c.get('description','')[:60]}")
    assert len(changes) > 0, "Expected at least one change"
    print("  [PASS] Diff logic works correctly")
    return True

# --- Run all ---
async def main():
    results = []
    results.append(await test_intents())
    results.append(test_image_processing())
    results.append(await test_text_extraction())
    results.append(test_models())
    results.append(test_routes())
    results.append(test_diff_logic())

    print("\n" + "=" * 50)
    if all(results):
        print("  ALL 6 VERIFICATION TESTS PASSED!")
    else:
        failed = [i + 1 for i, r in enumerate(results) if not r]
        print(f"  TESTS FAILED: {failed}")
        sys.exit(1)
    print("=" * 50)

if __name__ == "__main__":
    asyncio.run(main())
