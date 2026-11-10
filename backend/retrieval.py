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
from urllib.parse import quote_plus

import chromadb
import httpx
from bs4 import BeautifulSoup
from chromadb.config import Settings
from rank_bm25 import BM25Okapi

from models import Citation, RetrievalResult
from web_scraper import scrape_legal_info

STORAGE_PATH = Path(os.getenv("STORAGE_PATH", str(Path(__file__).parent.parent / "storage")))
CHROMA_PATH = STORAGE_PATH / "derived" / "chroma"
BM25_PATH = STORAGE_PATH / "derived" / "bm25"

# The previous ecourtsindia.com JSON endpoint was retired (HTTP 410).  India
# Code now exposes its public catalogue through this official DSpace search.
INDIA_CODE_SEARCH_URL = "https://www.indiacode.nic.in/handle/123456789/1362/simple-search"
WEB_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36"
CONFIDENT_SCORE = 0.42
LEGAL_QUERY_ALIASES = {
    "rti": "right to information",
    "ipc": "indian penal code",
    "crpc": "code of criminal procedure",
}

# ── ChromaDB client (lazy init) ──────────────────────────────────

_chroma_client: Optional[chromadb.ClientAPI] = None
_chroma_collections: list = []  # cached collection objects
_bm25_indexes: dict[str, dict] = {}  # {name: {"bm25": BM25Okapi, "docs": [...], "meta": [...]}}


def _get_chroma() -> chromadb.ClientAPI:
    global _chroma_client, _chroma_collections
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(
            path=str(CHROMA_PATH),
            settings=Settings(anonymized_telemetry=False),
        )
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
        "please", "tell", "explain", "give", "need", "help", "want", "file", "from",
        "with", "have", "been", "this", "that", "your", "their",
    }
    words = re.sub(r"[^a-z0-9\s]", " ", question.lower()).split()
    return [w for w in words if len(w) > 3 and w not in stop][:8]


def _expand_legal_aliases(question: str) -> str:
    """Expand abbreviations used by people into the corpus's legal titles."""
    expanded = question
    for abbreviation, title in LEGAL_QUERY_ALIASES.items():
        expanded = re.sub(rf"\b{abbreviation}\b", title, expanded, flags=re.IGNORECASE)
    return expanded


def _query_coverage(question: str, result: dict) -> float:
    """Measure whether a local passage actually addresses the user's terms.

    Vector similarity alone is not trustworthy for this corpus because some
    persisted vectors use a legacy embedding model.  A passage must also
    contain meaningful query terms before it can block the web fallbacks.
    """
    terms = _keywords(_expand_legal_aliases(question))
    if not terms:
        return 0.0
    haystack = f"{result.get('act_name', '')} {result.get('content', '')}".lower()
    return sum(term in haystack for term in terms) / len(terms)


# ── Gemini Embedding ───────────────────────────────────────────


def _get_gemini_embedding(text: str) -> list[float] | None:
    api_key = os.getenv("GOOGLE_API_KEY", "").strip()
    if not api_key or api_key == "paste-your-google-api-key-here":
        return None
        
    model = os.getenv("GEMINI_EMBEDDING_MODEL", "text-embedding-004").strip()
    if not model:
        model = "text-embedding-004"
    model_path = model if model.startswith("models/") else f"models/{model}"

    # All persisted collections use 768-dimensional vectors. Requesting this
    # explicitly keeps gemini-embedding-001 compatible with the existing DB.
    embedding_dimensions = _get_chroma_embedding_dimension()
    payload = {
        "model": model_path,
        "content": {"parts": [{"text": text}]},
    }
    if embedding_dimensions:
        payload["outputDimensionality"] = embedding_dimensions

    try:
        url = f"https://generativelanguage.googleapis.com/v1beta/{model_path}:embedContent?key={api_key}"
        with httpx.Client(timeout=10.0) as client:
            resp = client.post(url, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                vector = data.get("embedding", {}).get("values")
                if vector:
                    return vector
            print(f"[retrieval] Gemini embedding request failed ({resp.status_code}): {resp.text[:200]}")
    except Exception as e:
        print(f"[retrieval] Gemini embedding failed: {e}")
    return None


def _get_chroma_embedding_dimension() -> int | None:
    """Read the persisted vector dimension without making a network request."""
    _get_chroma()
    for coll in _chroma_collections:
        if not coll.count():
            continue
        try:
            sample = coll.peek(limit=1).get("embeddings")
            if sample is not None and len(sample):
                return len(sample[0])
        except Exception as e:
            print(f"[retrieval] Could not inspect {coll.name} embedding dimension: {e}")
    return None


def _search_exact_reference(
    question: str, collections: list
) -> list[dict]:
    """Find a directly requested Article/Section in the local source text.

    The persisted Chroma vectors were built with an older embedding model, so
    a semantic query can rank a neighbouring provision above the exact legal
    provision requested.  Statutory references have a stronger signal than a
    vector score: scan the already-local collection for the numbered heading
    and place those passages ahead of semantic results.
    """
    match = re.search(r"\b(article|section|sec\.)\s+(\d+[a-z]?)\b", question, re.IGNORECASE)
    if not match:
        return []

    kind, number = match.group(1).lower(), match.group(2).lower()
    # Constitution PDFs label provisions as "Right to Freedom 19." rather
    # than "Article 19".  Do not match a bare ``19.`` anywhere: footnotes
    # and amendment years otherwise produce false citations.
    if kind == "article":
        heading = re.compile(
            rf"(?:\barticle\s+{re.escape(number)}\b|"
            rf"(?:^|\n)\s*{re.escape(number)}\s*[.\-—]|"
            rf"\bright\s+to\s+[^\n.]{{1,80}}?\s+{re.escape(number)}\s*[.\-—])",
            re.IGNORECASE,
        )
    else:
        heading = re.compile(
            rf"(?:\b(?:section|sec\.)\s+{re.escape(number)}\b|"
            rf"(?:^|\n)\s*{re.escape(number)}\s*[.\-—])",
            re.IGNORECASE,
        )
    exact: list[dict] = []
    seen: set[str] = set()
    for coll in collections:
        try:
            records = coll.get(include=["documents", "metadatas"])
            documents = records.get("documents") or []
            metadatas = records.get("metadatas") or []
            for index, document in enumerate(documents):
                heading_match = heading.search(document) if document else None
                if not heading_match:
                    continue
                meta = metadatas[index] if index < len(metadatas) and metadatas[index] else {}
                # Long PDF chunks may start several pages before the matched
                # heading.  Display the statutory provision, not that prefix.
                matched_excerpt = document[heading_match.start():]
                key = _document_key(matched_excerpt)
                if key in seen:
                    continue
                seen.add(key)
                nearby = document[
                    max(0, heading_match.start() - 120): heading_match.start() + 300
                ].lower()
                # Prefer the provision's title over references to the same
                # number in a schedule, cross-reference, or amendment note.
                priority = 10
                if kind == "article" and (
                    "right to freedom" in nearby
                    or "protection of certain rights" in nearby
                ):
                    priority += 100
                elif re.search(
                    rf"(?:^|\n)\s*{re.escape(number)}\s*[.\-—]\s*[a-z]",
                    document,
                    re.IGNORECASE,
                ):
                    priority += 40

                exact.append({
                    "content": matched_excerpt,
                    "act_name": meta.get("act_name") or _better_act_name(coll.name, "", document),
                    "section": number,
                    "act_year": meta.get("act_year", meta.get("year")),
                    "source_url": meta.get("source_url", meta.get("url")),
                    "score": 1.0,
                    "collection": coll.name,
                    "exact_priority": priority,
                    "is_exact_reference": True,
                })
        except Exception as e:
            print(f"[retrieval] Exact reference lookup failed for {coll.name}: {e}")
    exact.sort(key=lambda result: result["exact_priority"], reverse=True)
    for result in exact:
        result.pop("exact_priority", None)
    return exact[:4]


# ── ChromaDB dense search ────────────────────────────────────────


def _search_chroma(
    question: str, n_results: int = 8, target_collections: list[str] | None = None
) -> list[dict]:
    """Search across all ChromaDB collections and return merged results."""
    _get_chroma()  # ensure initialized
    if not _chroma_collections:
        return []

    collections = _chroma_collections
    if target_collections:
        matching = [
            coll for coll in _chroma_collections
            if coll.name.replace("_bm25", "") in target_collections
        ]
        if matching:
            collections = matching

    exact_results = _search_exact_reference(question, collections)

    query_vector = _get_gemini_embedding(question)
    if query_vector is None:
        print("[retrieval] Dense search skipped because no compatible query embedding was available")
        return exact_results

    all_results: list[dict] = list(exact_results)
    exact_keys = {_document_key(result["content"]) for result in exact_results}

    for coll in collections:
        try:
            count = coll.count()
            if count == 0:
                continue
                
            results = coll.query(query_embeddings=[query_vector], n_results=min(n_results, count))
                
            if not results["documents"] or not results["documents"][0]:
                continue

            for i, doc in enumerate(results["documents"][0]):
                if _document_key(doc) in exact_keys:
                    continue
                meta = results["metadatas"][0][i] if results["metadatas"] and results["metadatas"][0] else {}
                distance = results["distances"][0][i] if results["distances"] and results["distances"][0] else 1.0
                similarity = 1.0 / (1.0 + distance)
                act_name = meta.get("act_name", meta.get("source", coll.name))
                if act_name == coll.name:
                    act_name = _better_act_name(coll.name, "", doc)

                all_results.append({
                    "content": doc,
                    "act_name": act_name,
                    "section": meta.get("section", meta.get("section_number")),
                    "act_year": meta.get("act_year", meta.get("year")),
                    "source_url": meta.get("source_url", meta.get("url")),
                    "score": similarity,
                    "collection": coll.name,
                })
        except Exception as e:
            msg = str(e)
            print(f"[retrieval] Error querying collection {coll.name}: {msg}")

    # Exact statutory headings must stay ahead of approximate semantic matches.
    return exact_results + sorted(
        all_results[len(exact_results):], key=lambda r: r["score"], reverse=True
    )[:max(0, n_results - len(exact_results))]


# ── BM25 keyword search ──────────────────────────────────────────


def _collection_label(name: str) -> str:
    """Convert index filename like 'constitution_bm25' to 'Constitution'."""
    return name.replace("_bm25", "").replace("_", " ").title()


def _extract_section_from_text(text: str) -> str | None:
    """Try to extract a section/article number from BM25 document text."""
    # Match patterns like 'section 302', 'article 21', 'section 473'.  Legal
    # PDFs often use a period after the number, so tolerate that formatting too.
    m = re.search(r'\b(?:section|article|sec\.|art\.)\s*(\d+[a-z]?)\b', text[:500], re.IGNORECASE)
    if m:
        return m.group(1)
    return None


def _document_key(content: str) -> str:
    """Make the same passage from Chroma and BM25 compare equal for RRF.

    BM25 stores tokenized text while Chroma stores the original text.  Comparing
    the first raw characters made matching passages look unrelated, preventing
    reciprocal-rank fusion from rewarding agreement between the two retrievers.
    """
    return re.sub(r"[^a-z0-9]+", " ", content.lower()).strip()[:500]


def _better_act_name(name: str, source_id: str, doc_text: str) -> str:
    """Derive a meaningful act name from the BM25 index name and source ID."""
    base = name.replace("_bm25", "")
    
    # Map known index names to proper act names
    ACT_LABELS = {
        "constitution": "Constitution of India",
        "bns": "Bharatiya Nyaya Sanhita (BNS)",
        "bnss": "Bharatiya Nagarik Suraksha Sanhita (BNSS)",
        "bsa": "Bharatiya Sakshya Adhiniyam (BSA)",
        "central_acts": "Central Acts",
        "legal_qa": "Legal Q&A Database",
        "supreme_court": "Supreme Court Judgment",
    }
    label = ACT_LABELS.get(base)
    if label:
        return label
    
    return _collection_label(name)


def _search_bm25(
    question: str, n_results: int = 8, target_collections: list[str] | None = None
) -> list[dict]:
    """Search across all BM25 indexes and return merged results.
    
    When target_collections is given, search those indexes first with more
    result slots. Other indexes are searched for supplementary results only.
    """
    _load_bm25_indexes()
    if not _bm25_indexes:
        return []

    clean_query = re.sub(r"[^a-z0-9\s]", " ", _expand_legal_aliases(question).lower())
    tokenized_query = clean_query.split()
    all_results: list[dict] = []

    # Separate targeted and non-targeted indexes
    targeted_names = []
    other_names = []
    if target_collections:
        for idx_name in _bm25_indexes:
            base = idx_name.replace("_bm25", "")
            if base in target_collections:
                targeted_names.append(idx_name)
            else:
                other_names.append(idx_name)
    else:
        other_names = list(_bm25_indexes.keys())

    def _search_index(name: str, max_results: int) -> list[dict]:
        results = []
        try:
            index_data = _bm25_indexes[name]
            bm25 = index_data["bm25"]
            corpus = index_data["corpus"]
            ids = index_data.get("ids", [])

            scores = bm25.get_scores(tokenized_query)
            top_indices = scores.argsort()[-max_results:][::-1]

            for idx in top_indices:
                if scores[idx] <= 0.1:
                    continue
                
                doc_tokens = corpus[idx] if idx < len(corpus) else []
                doc_text = " ".join(doc_tokens)
                source_id = ids[idx] if idx < len(ids) else ""
                
                results.append({
                    "content": doc_text,
                    "act_name": _better_act_name(name, source_id, doc_text),
                    "section": _extract_section_from_text(doc_text),
                    "act_year": None,
                    "source_url": None,
                    "score": float(scores[idx]),
                    "collection": name,
                    "source_id": source_id,
                })
        except Exception as e:
            print(f"[retrieval] Error searching BM25 {name}: {e}")
        return results

    # Search targeted indexes first with more slots
    if targeted_names:
        for name in targeted_names:
            all_results.extend(_search_index(name, n_results))
        # Only add a few supplementary results from other indexes
        for name in other_names:
            all_results.extend(_search_index(name, max(2, n_results // 4)))
    else:
        for name in other_names:
            all_results.extend(_search_index(name, n_results))

    all_results.sort(key=lambda r: r["score"], reverse=True)
    if target_collections:
        target_results = [
            result for result in all_results
            if result["collection"].replace("_bm25", "") in target_collections
        ]
        other_results = [
            result for result in all_results
            if result["collection"].replace("_bm25", "") not in target_collections
        ]
        # Do not allow a high-scoring but unrelated judgment to displace the
        # requested Act before the caller has a chance to assess relevance.
        if target_results:
            return (target_results + other_results[:max(2, n_results // 4)])[:n_results]
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
        key = _document_key(result["content"])
        scores[key] = scores.get(key, 0) + 1.0 / (k + rank + 1)
        docs[key] = result

    for rank, result in enumerate(sparse_results):
        key = _document_key(result["content"])
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
    """Search the official India Code catalogue as the final retrieval tier.

    The public JSON endpoint was retired, so this uses the official catalogue
    page.  If it is temporarily slow or unavailable, return a transparent
    official-search citation rather than silently losing the final fallback.
    """
    terms = _keywords(question)
    if not terms:
        return []

    search_url = (
        f"{INDIA_CODE_SEARCH_URL}?query={quote_plus(question)}"
        "&rpp=10&sort_by=score&order=desc&etal=0"
    )
    try:
        async with httpx.AsyncClient(
            timeout=8.0,
            headers={"User-Agent": WEB_USER_AGENT, "Accept": "text/html,application/xhtml+xml"},
            follow_redirects=True,
        ) as client:
            response = await client.get(INDIA_CODE_SEARCH_URL, params={
                "query": question,
                "rpp": 10,
                "sort_by": "score",
                "order": "desc",
                "etal": 0,
            })
        if response.status_code != 200:
            print(f"[retrieval] India Code responded {response.status_code}")
            raise RuntimeError(f"HTTP {response.status_code}")
    except Exception as e:
        print(f"[retrieval] India Code catalogue unavailable: {e}")
        return [Citation(
            index=1,
            actName="India Code — official statutory search",
            section=None,
            year=None,
            sourceUrl=search_url,
            excerpt=(
                f"Official India Code search for: {question}. Open this source "
                "to verify the current text of the applicable Act or provision."
            ),
            origin="indiacode",
            score=None,
        )]

    soup = BeautifulSoup(response.text, "lxml")
    citations: list[Citation] = []
    seen_urls: set[str] = set()
    for link in soup.select("a[href*='/handle/']"):
        href = link.get("href", "")
        title = _excerpt(link.get_text(" ", strip=True), 180)
        # Ignore catalogue navigation and keep Act-result links only.
        if not title or "simple-search" in href or href in seen_urls:
            continue
        full_url = href if href.startswith("http") else f"https://www.indiacode.nic.in{href}"
        seen_urls.add(href)
        year_match = re.search(r"\b(18|19|20)\d{2}\b", title)
        citations.append(Citation(
            index=len(citations) + 1,
            actName=title,
            section=None,
            year=int(year_match.group(0)) if year_match else None,
            sourceUrl=full_url,
            excerpt=f"{title} — listed in the official India Code catalogue.",
            origin="indiacode",
            score=None,
        ))
        if len(citations) == 4:
            break

    return citations or [Citation(
        index=1,
        actName="India Code — official statutory search",
        section=None,
        year=None,
        sourceUrl=search_url,
        excerpt=f"Official India Code search for: {question}.",
        origin="indiacode",
        score=None,
    )]


# ── Query-aware collection detection ─────────────────────────────


def _detect_target_collections(question: str) -> list[str]:
    """Detect which legal collection(s) the user is likely asking about.
    
    Returns a list of collection name prefixes (e.g. ['bns', 'bnss']).
    Empty list means no specific target detected — use all collections.
    """
    q = question.lower()
    targets = []
    
    # Specific act mentions
    if re.search(r"\bbns\b", q) or any(
        kw in q for kw in ("bharatiya nyaya", "bhartiya nyaya")
    ):
        targets.append("bns")
    if re.search(r"\bbnss\b", q) or any(
        kw in q for kw in ("bharatiya nagarik suraksha", "bhartiya nagarik")
    ):
        targets.append("bnss")
    if re.search(r"\bbsa\b", q) or any(
        kw in q for kw in ("bharatiya sakshya", "bhartiya sakshya", "evidence act")
    ):
        targets.append("bsa")
    if any(kw in q for kw in ("constitution", "fundamental right", "article ", "directive principle")):
        targets.append("constitution")
    if any(kw in q for kw in ("central act", "rti ", "right to information", 
                               "consumer protection", "motor vehicle", "ipc ",
                               "crpc ", "cyber crime", "it act", "information technology")):
        targets.append("central_acts")
    
    return targets


def _filter_by_target(results: list[dict], targets: list[str]) -> list[dict]:
    """If target collections are detected, prioritize results from those collections.
    
    - Keep all results from target collections
    - Only include non-target results if we need to fill up the result set
    """
    if not targets:
        return results
    
    target_results = []
    other_results = []
    
    for r in results:
        coll = r.get("collection", "")
        # Normalize: strip _bm25 suffix so 'constitution_bm25' matches target 'constitution'
        coll_base = coll.replace("_bm25", "")
        is_target = coll_base in targets
        if is_target:
            target_results.append(r)
        else:
            other_results.append(r)
    
    if not target_results:
        # No target results found, return all
        return results
    
    # Results are already score-sorted.  Preserve that ordering within each
    # group, but do not re-sort the combined list: doing so would let a high
    # scoring result from an unrelated corpus displace the requested Act.
    combined = target_results + other_results[:2]
    return combined[:8]


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

    # Detect which collection(s) the user is targeting
    targets = _detect_target_collections(question)
    if targets:
        print(f"[retrieval] Detected target collections: {targets}")

    # ── Step 1: Search LOCAL databases ────────────────────────────
    print(f"[retrieval] Step 1: Searching LOCAL ChromaDB vector database...")
    dense_results = _search_chroma(question, target_collections=targets)
    dense_results = _filter_by_target(dense_results, targets)
    print(f"[retrieval]   → ChromaDB returned {len(dense_results)} results")

    print(f"[retrieval] Step 2: Searching LOCAL BM25 keyword indexes...")
    sparse_results = _search_bm25(question, target_collections=targets)
    sparse_results = _filter_by_target(sparse_results, targets)
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

    # A directly matched provision is more reliable than an approximate BM25
    # hit (for example, an Article 39 amendment footnote on an Article 19
    # question).  Keep exact local statutory passages first in the citations.
    exact_local = [result for result in dense_results if result.get("is_exact_reference")]
    if exact_local:
        exact_keys = {_document_key(result["content"]) for result in exact_local}
        fused = exact_local + [
            result for result in fused
            if _document_key(result["content"]) not in exact_keys
        ]
        fused = fused[:8]
    fused = _filter_by_target(fused, targets)

    # ── Step 3: Filter by confidence threshold ────────────────────
    for result in fused:
        result["query_coverage"] = _query_coverage(question, result)

    # Keep local RAG first whenever it contains a real match.  Exact legal
    # references always qualify; other passages need enough user-term overlap
    # to avoid serving an unrelated local excerpt instead of a useful fallback.
    confident_results = [
        result for result in fused
        if result["score"] >= MIN_CONFIDENCE_SCORE
        and (
            not targets
            or result.get("collection", "").replace("_bm25", "") in targets
        )
        and (
            result.get("is_exact_reference")
            or result["query_coverage"] >= 0.34
        )
    ]
    confident_results.sort(
        key=lambda result: (
            bool(result.get("is_exact_reference")),
            result["query_coverage"],
            result["score"],
        ),
        reverse=True,
    )
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
                # Local records without an original URL must remain local.
                # Do not attach a generic India Code home-page link: that
                # incorrectly makes a corpus citation look like a web fallback.
                sourceUrl=r.get("source_url"),
                excerpt=_excerpt(r["content"]),
                origin="corpus",
                score=round(r["score"], 4),
            )
            for i, r in enumerate(confident_results)
        ]

        return RetrievalResult(
            citations=rag_citations,
            context=_build_context(rag_citations),
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
