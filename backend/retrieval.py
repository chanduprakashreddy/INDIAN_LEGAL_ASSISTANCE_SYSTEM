"""Hybrid retrieval: ChromaDB dense search + BM25 keyword search with RRF fusion.

Fallback chain: RAG (local DB) → Web Scraping (Indian Kanoon) → India Code API → none.
Provides both general legal information and personal case assistance.
"""

from __future__ import annotations

import os
import pickle
import re
from pathlib import Path
from typing import Optional

import chromadb
import httpx
from rank_bm25 import BM25Okapi

from models import Citation, RetrievalResult
from web_scraper import scrape_legal_info

STORAGE_PATH = Path(os.getenv("STORAGE_PATH", str(Path(__file__).parent.parent / "storage")))
CHROMA_PATH = STORAGE_PATH / "derived" / "chroma"
BM25_PATH = STORAGE_PATH / "derived" / "bm25"

INDIA_CODE_URL = "https://indiacode.ecourtsindia.com/api/v1/acts"
CONFIDENT_SCORE = 0.42

# ── ChromaDB client (lazy init) ──────────────────────────────────

_chroma_client: Optional[chromadb.ClientAPI] = None
_chroma_collections: list = []  # cached collection objects
_bm25_indexes: dict[str, dict] = {}  # {name: {"bm25": BM25Okapi, "docs": [...], "meta": [...]}}


def _get_chroma() -> chromadb.ClientAPI:
    global _chroma_client, _chroma_collections
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(path=str(CHROMA_PATH))
        print(f"[retrieval] ChromaDB loaded from {CHROMA_PATH}")
        # v0.6.0: list_collections returns names (str), not collection objects
        coll_names = _chroma_client.list_collections()
        print(f"[retrieval] Collection names found: {coll_names}")
        _chroma_collections = []
        for name in coll_names:
            try:
                coll = _chroma_client.get_collection(name)
                _chroma_collections.append(coll)
            except Exception as e:
                print(f"[retrieval] Could not load collection {name}: {e}")
        print(f"[retrieval] Loaded {len(_chroma_collections)} collections")
    return _chroma_client


def _load_bm25_indexes() -> None:
    """Load all BM25 pickle indexes from the bm25 directory.
    
    Each pickle file contains:
      - corpus: list of pre-tokenized word lists (list[list[str]])
      - ids: list of source file path strings
    """
    global _bm25_indexes
    if _bm25_indexes:
        return
    if not BM25_PATH.exists():
        print(f"[retrieval] BM25 path {BM25_PATH} not found, skipping")
        return
    for pkl_file in BM25_PATH.glob("*.pkl"):
        name = pkl_file.stem
        try:
            with open(pkl_file, "rb") as f:
                data = pickle.load(f)

            if not isinstance(data, dict) or "corpus" not in data:
                print(f"[retrieval] Unexpected BM25 format for {name}: {type(data)}, keys={list(data.keys()) if isinstance(data, dict) else 'N/A'}")
                continue

            corpus = data["corpus"]  # list of tokenized word lists
            ids = data.get("ids", [])
            
            # Build BM25 index from pre-tokenized corpus
            bm25 = BM25Okapi(corpus)
            
            _bm25_indexes[name] = {
                "bm25": bm25,
                "corpus": corpus,
                "ids": ids,
            }
            print(f"[retrieval] BM25 index loaded: {name} ({len(corpus)} documents)")
        except Exception as e:
            print(f"[retrieval] Failed to load BM25 index {name}: {e}")


# ── Snippet helpers ──────────────────────────────────────────────


def _excerpt(text: str, limit: int = 900) -> str:
    clean = re.sub(r"\s+", " ", text).strip()
    return clean[:limit] + "…" if len(clean) > limit else clean


def _keywords(question: str) -> list[str]:
    stop = {
        "what", "which", "where", "when", "how", "the", "and", "for", "are", "is",
        "of", "in", "to", "a", "an", "my", "me", "i", "do", "does", "can", "should",
        "about", "under", "law", "laws", "legal", "india", "indian", "act", "section",
        "please", "tell", "explain", "give", "need", "help",
    }
    words = re.sub(r"[^a-z0-9\s]", " ", question.lower()).split()
    return [w for w in words if len(w) > 3 and w not in stop][:8]


# ── Gemini Embedding ───────────────────────────────────────────


def _get_gemini_embedding(text: str) -> list[float] | None:
    api_key = os.getenv("GOOGLE_API_KEY", "").strip()
    if not api_key or api_key == "paste-your-google-api-key-here":
        return None
        
    try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key={api_key}"
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(
                url,
                json={
                    "model": "models/text-embedding-004",
                    "content": {"parts": [{"text": text}]}
                }
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("embedding", {}).get("values")
    except Exception as e:
        print(f"[retrieval] Gemini embedding failed: {e}")
    return None


# ── ChromaDB dense search ────────────────────────────────────────


def _search_chroma(question: str, n_results: int = 8) -> list[dict]:
    """Search across all ChromaDB collections and return merged results."""
    _get_chroma()  # ensure initialized
    if not _chroma_collections:
        return []

    query_vector = _get_gemini_embedding(question)
    
    all_results: list[dict] = []

    for coll in _chroma_collections:
        try:
            count = coll.count()
            if count == 0:
                continue
                
            if query_vector:
                results = coll.query(query_embeddings=[query_vector], n_results=min(n_results, count))
            else:
                results = coll.query(query_texts=[question], n_results=min(n_results, count))
                
            if not results["documents"] or not results["documents"][0]:
                continue

            for i, doc in enumerate(results["documents"][0]):
                meta = results["metadatas"][0][i] if results["metadatas"] and results["metadatas"][0] else {}
                distance = results["distances"][0][i] if results["distances"] and results["distances"][0] else 1.0
                similarity = 1.0 / (1.0 + distance)

                all_results.append({
                    "content": doc,
                    "act_name": meta.get("act_name", meta.get("source", coll.name)),
                    "section": meta.get("section", meta.get("section_number")),
                    "act_year": meta.get("act_year", meta.get("year")),
                    "source_url": meta.get("source_url", meta.get("url")),
                    "score": similarity,
                    "collection": coll.name,
                })
        except Exception as e:
            msg = str(e)
            if "dimension" in msg.lower():
                pass
            else:
                print(f"[retrieval] Error querying collection {coll.name}: {e}")

    all_results.sort(key=lambda r: r["score"], reverse=True)
    return all_results[:n_results]


# ── BM25 keyword search ──────────────────────────────────────────


def _collection_label(name: str) -> str:
    """Convert index filename like 'constitution_bm25' to 'Constitution'."""
    return name.replace("_bm25", "").replace("_", " ").title()


def _search_bm25(question: str, n_results: int = 8) -> list[dict]:
    """Search across all BM25 indexes and return merged results."""
    _load_bm25_indexes()
    if not _bm25_indexes:
        return []

    clean_query = re.sub(r"[^a-z0-9\s]", " ", question.lower())
    tokenized_query = clean_query.split()
    all_results: list[dict] = []

    for name, index_data in _bm25_indexes.items():
        try:
            bm25 = index_data["bm25"]
            corpus = index_data["corpus"]
            ids = index_data.get("ids", [])

            scores = bm25.get_scores(tokenized_query)
            top_indices = scores.argsort()[-n_results:][::-1]

            for idx in top_indices:
                if scores[idx] <= 0.1:
                    continue
                
                # Reconstruct document text from tokenized words
                doc_tokens = corpus[idx] if idx < len(corpus) else []
                doc_text = " ".join(doc_tokens)
                
                # Extract source info from ID (file path)
                source_id = ids[idx] if idx < len(ids) else ""
                
                all_results.append({
                    "content": doc_text,
                    "act_name": _collection_label(name),
                    "section": None,
                    "act_year": None,
                    "source_url": None,
                    "score": float(scores[idx]),
                    "collection": name,
                    "source_id": source_id,
                })
        except Exception as e:
            print(f"[retrieval] Error searching BM25 {name}: {e}")

    all_results.sort(key=lambda r: r["score"], reverse=True)
    return all_results[:n_results]


# ── Reciprocal Rank Fusion ────────────────────────────────────────


def _rrf_fuse(
    dense_results: list[dict],
    sparse_results: list[dict],
    k: int = 60,
    top_n: int = 8,
) -> list[dict]:
    """Merge dense (ChromaDB) and sparse (BM25) results using RRF."""
    scores: dict[str, float] = {}
    docs: dict[str, dict] = {}
    
    # Store original max scores to preserve signal strength
    max_dense = dense_results[0]["score"] if dense_results else 0
    max_sparse = sparse_results[0]["score"] if sparse_results else 0

    for rank, result in enumerate(dense_results):
        key = result["content"][:200]
        scores[key] = scores.get(key, 0) + 1.0 / (k + rank + 1)
        docs[key] = result

    for rank, result in enumerate(sparse_results):
        key = result["content"][:200]
        scores[key] = scores.get(key, 0) + 1.0 / (k + rank + 1)
        if key not in docs:
            docs[key] = result

    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_n]
    results = []
    
    # RRF scores are artificially tiny (~0.016). Let's boost them back 
    # to the domain of the original vector similarity so thresholding still works!
    boost = max(max_dense, max_sparse, 0.1) / (1.0 / (k + 1))
    
    for key, fused_score in ranked:
        doc = docs[key]
        doc["score"] = fused_score * boost
        results.append(doc)

    return results


# ── India Code fallback ──────────────────────────────────────────


async def _search_indiacode(question: str) -> list[Citation]:
    """Keyword-match against India Code public API — same as original."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(INDIA_CODE_URL, headers={"Accept": "application/json"})
        if response.status_code != 200:
            print(f"[retrieval] India Code responded {response.status_code}")
            return []

        payload = response.json()
        acts = payload if isinstance(payload, list) else payload.get("data", payload.get("acts", []))
    except Exception as e:
        print(f"[retrieval] India Code unreachable: {e}")
        return []

    terms = _keywords(question)
    if not terms:
        return []

    scored = []
    for act in acts:
        title = act.get("title") or act.get("name") or act.get("act_name") or act.get("short_title") or "Act"
        haystack = f"{title} {act.get('description', '')} {act.get('summary', '')}".lower()
        hits = sum(1 for t in terms if t in haystack)
        if hits > 0:
            scored.append({"act": act, "title": title, "hits": hits})

    scored.sort(key=lambda x: x["hits"], reverse=True)
    scored = scored[:4]

    return [
        Citation(
            index=i + 1,
            actName=entry["title"],
            section=None,
            year=int(entry["act"].get("year") or entry["act"].get("act_year") or 0) or None,
            sourceUrl=entry["act"].get("url") or entry["act"].get("link") or "https://www.indiacode.nic.in/",
            excerpt=_excerpt(
                entry["act"].get("description")
                or entry["act"].get("summary")
                or f"{entry['title']} — listed in the India Code register of central Acts.",
                400,
            ),
            origin="indiacode",
            score=None,
        )
        for i, entry in enumerate(scored)
    ]


# ── Main retrieval function ──────────────────────────────────────


async def retrieve_context(question: str) -> RetrievalResult:
    """Hybrid search: LOCAL DATABASE FIRST, then web scraping, then IndiaCode.

    Key behaviour:
    - If RAG returns HIGH-confidence results (score >= MIN_CONFIDENCE_SCORE) → use them
    - If RAG returns only LOW-confidence results → treat as "no good match", fall through
      to web scraping and IndiaCode
    - Combines RAG + web-scraped results when RAG is partial match
    """

    MIN_CONFIDENCE_SCORE = 0.30  # Minimum score to consider a RAG result "relevant"

    # ── Step 1: Search LOCAL databases ────────────────────────────
    print(f"[retrieval] Step 1: Searching LOCAL ChromaDB vector database...")
    dense_results = _search_chroma(question)
    print(f"[retrieval]   → ChromaDB returned {len(dense_results)} results")

    print(f"[retrieval] Step 2: Searching LOCAL BM25 keyword indexes...")
    sparse_results = _search_bm25(question)
    print(f"[retrieval]   → BM25 returned {len(sparse_results)} results")

    # ── Step 2: Fuse local results ────────────────────────────────
    if dense_results and sparse_results:
        fused = _rrf_fuse(dense_results, sparse_results)
    elif dense_results:
        fused = dense_results
    elif sparse_results:
        fused = sparse_results
    else:
        fused = []

    # ── Step 3: Filter by confidence threshold ────────────────────
    confident_results = [r for r in fused if r["score"] >= MIN_CONFIDENCE_SCORE]
    low_confidence = len(fused) > 0 and len(confident_results) == 0

    if low_confidence:
        print(f"[retrieval] ⚠️ RAG returned {len(fused)} results but ALL below confidence threshold ({MIN_CONFIDENCE_SCORE})")
        for i, r in enumerate(fused[:3]):
            print(f"[retrieval]   [{i+1}] score={r['score']:.4f} (BELOW threshold) — {r.get('act_name','?')}")

    if confident_results:
        print(f"[retrieval] ✅ LOCAL DATABASE has {len(confident_results)} confident results")
        for i, r in enumerate(confident_results[:3]):
            print(f"[retrieval]   [{i+1}] collection={r['collection']}, act={r.get('act_name','?')}, score={r['score']:.4f}")

        rag_citations = [
            Citation(
                index=i + 1,
                actName=r["act_name"] or "Unknown",
                section=r.get("section"),
                year=int(r["act_year"]) if r.get("act_year") else None,
                sourceUrl=r.get("source_url"),
                excerpt=_excerpt(r["content"]),
                origin="corpus",
                score=round(r["score"], 4),
            )
            for i, r in enumerate(confident_results)
        ]

        # Also try web scraping for supplementary personal-case info
        print(f"[retrieval] Step 3b: Also checking web for supplementary info...")
        scraped = await scrape_legal_info(question)
        if scraped:
            print(f"[retrieval]   → Web scraping added {len(scraped)} supplementary results")
            # Re-index the scraped citations to continue after RAG citations
            for j, sc in enumerate(scraped):
                sc.index = len(rag_citations) + j + 1
            all_citations = rag_citations + scraped
        else:
            all_citations = rag_citations

        return RetrievalResult(
            citations=all_citations,
            context=_build_context(all_citations),
            grounding="corpus",
        )

    # ── Step 4: Try web scraping (Indian Kanoon) ──────────────────
    print(f"[retrieval] ⚠️ No confident local results — trying web scraping (Indian Kanoon)...")
    scraped = await scrape_legal_info(question)
    if scraped:
        print(f"[retrieval]   → Web scraping returned {len(scraped)} results")
        return RetrievalResult(
            citations=scraped,
            context=_build_context(scraped),
            grounding="webscrape",
        )

    # ── Step 5: Fall back to IndiaCode API ────────────────────────
    print(f"[retrieval] ⚠️ Web scraping returned 0 results — falling back to IndiaCode web URL...")
    external = await _search_indiacode(question)
    if external:
        print(f"[retrieval]   → IndiaCode returned {len(external)} results")
        return RetrievalResult(
            citations=list(external),
            context=_build_context(list(external)),
            grounding="indiacode",
        )

    # ── Step 6: Nothing found — but still help the user ───────────
    print(f"[retrieval] ❌ No results from local DB, web scraping, or IndiaCode")
    return RetrievalResult(citations=[], context="", grounding="none")


def _build_context(citations: list[Citation]) -> str:
    parts = []
    for c in citations:
        header_parts = [f"[{c.index}]", c.actName]
        if c.section:
            header_parts.append(f"Section {c.section}")
        if c.year:
            header_parts.append(f"({c.year})")
        if c.origin == "indiacode":
            header_parts.append("— from the India Code register")
        elif c.origin == "corpus":
            header_parts.append("— from local vector database")
        elif c.origin == "webscrape":
            header_parts.append("— from Indian Kanoon (web)")
        header = " ".join(header_parts)
        parts.append(f"{header}\n{c.excerpt}")
    return "\n\n".join(parts)
