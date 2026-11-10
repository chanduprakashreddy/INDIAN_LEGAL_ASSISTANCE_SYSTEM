# -*- coding: utf-8 -*-
"""Diagnostic test: verify BM25 and ChromaDB are BOTH returning results independently."""
import asyncio
import sys
import os
import io

# Force UTF-8 output
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

sys.path.insert(0, os.path.dirname(__file__))
os.chdir(os.path.dirname(__file__))

from dotenv import load_dotenv
# Load backend/.env first (has the API key), then root .env as fallback
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"), override=True)
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"), override=False)

import retrieval
from retrieval import (
    _get_chroma, _chroma_collections, _load_bm25_indexes, _bm25_indexes,
    _search_chroma, _search_bm25, _rrf_fuse, retrieve_context
)

QUERIES = [
    "What is Article 21 of the Indian Constitution?",
    "Section 302 of BNS",
    "bail provisions under BNSS",
    "right to information act",
]

def test_chroma():
    print("=" * 70)
    print("  TEST 1: ChromaDB Dense Search")
    print("=" * 70)
    _get_chroma()
    print(f"\n  Collections loaded: {len(retrieval._chroma_collections)}")
    for coll in retrieval._chroma_collections:
        print(f"    - {coll.name}: {coll.count()} documents")
    
    for q in QUERIES:
        print(f"\n  Query: {q}")
        results = _search_chroma(q, n_results=3)
        if results:
            print(f"  -> {len(results)} results")
            for i, r in enumerate(results):
                print(f"    [{i+1}] score={r['score']:.4f} | collection={r['collection']} | act={r.get('act_name','?')}")
                print(f"        section={r.get('section','N/A')} | url={r.get('source_url','N/A')}")
                print(f"        content={r['content'][:100]}...")
        else:
            print(f"  -> NO RESULTS from ChromaDB")

def test_bm25():
    print("\n" + "=" * 70)
    print("  TEST 2: BM25 Keyword Search")  
    print("=" * 70)
    _load_bm25_indexes()
    print(f"\n  BM25 indexes loaded: {len(_bm25_indexes)}")
    for name, data in _bm25_indexes.items():
        print(f"    - {name}: {len(data['corpus'])} documents")
    
    for q in QUERIES:
        print(f"\n  Query: {q}")
        results = _search_bm25(q, n_results=3)
        if results:
            print(f"  -> {len(results)} results")
            for i, r in enumerate(results):
                print(f"    [{i+1}] score={r['score']:.4f} | collection={r['collection']} | act={r.get('act_name','?')}")
                print(f"        section={r.get('section','N/A')} | url={r.get('source_url','N/A')}")
                print(f"        content={r['content'][:100]}...")
        else:
            print(f"  -> NO RESULTS from BM25")

async def test_full_retrieval():
    print("\n" + "=" * 70)
    print("  TEST 3: Full Hybrid Retrieval (BM25 + ChromaDB + RRF)")
    print("=" * 70)
    
    for q in QUERIES:
        print(f"\n  Query: {q}")
        result = await retrieve_context(q)
        print(f"  -> Grounding: {result.grounding}")
        print(f"  -> Citations: {len(result.citations)}")
        for i, c in enumerate(result.citations[:3]):
            print(f"    [{i+1}] actName={c.actName} | section={c.section} | year={c.year}")
            print(f"        origin={c.origin} | score={c.score}")
            print(f"        sourceUrl={c.sourceUrl}")
            print(f"        excerpt={c.excerpt[:120]}...")
        
        # Check citation quality for frontend display
        if result.citations:
            issues = []
            for c in result.citations:
                if not c.actName or c.actName in ("Unknown", "Supreme Court"):
                    issues.append(f"Citation {c.index}: bad actName '{c.actName}'")
                if not c.excerpt or len(c.excerpt) < 10:
                    issues.append(f"Citation {c.index}: empty/short excerpt")
            if issues:
                print(f"  CITATION ISSUES:")
                for iss in issues:
                    print(f"       {iss}")
            else:
                print(f"  OK: Citations look good for display")
        else:
            print(f"  WARNING: No citations -- frontend will show 'General guidance'")

if __name__ == "__main__":
    print("\nRETRIEVAL DIAGNOSTIC TEST\n")
    test_chroma()
    test_bm25()
    asyncio.run(test_full_retrieval())
    print("\n" + "=" * 70)
    print("  DIAGNOSTIC COMPLETE")
    print("=" * 70)
