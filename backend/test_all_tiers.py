"""Test all retrieval tiers: Local RAG (ChromaDB + BM25), Web Scraping (Indian Kanoon), India Code API."""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
os.chdir(os.path.dirname(__file__))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"), override=True)

from retrieval import retrieve_context


async def test_all_tiers():
    queries = [
        ("What is Section 302 of BNS?", "BNS / statutory"),
        ("fundamental rights article 21 constitution", "Constitution"),
        ("bail provisions under BNSS", "BNSS"),
        ("right to information act", "Central Acts"),
        ("supreme court judgment on dowry", "Supreme Court"),
    ]

    print("=" * 70)
    print("  RETRIEVAL TIER TEST")
    print("=" * 70)

    for query, label in queries:
        print(f"\n--- Query: {query}")
        print(f"    Expected: {label}")

        try:
            result = await retrieve_context(query)
            print(f"    Grounding: {result.grounding}")
            if result.citations:
                print(f"    Citations: {len(result.citations)}")
                for i, c in enumerate(result.citations[:3], 1):
                    sec = (c.section or "")[:60]
                    print(f"      {i}. [{c.actName}] {sec} | score={c.score} | origin={c.origin}")
            else:
                print(f"    No citations. Context: {result.context[:120] if result.context else 'NONE'}...")
        except Exception as e:
            print(f"    ERROR: {e}")

    print(f"\n{'=' * 70}")
    print("  DONE")
    print(f"{'=' * 70}")


if __name__ == "__main__":
    asyncio.run(test_all_tiers())
