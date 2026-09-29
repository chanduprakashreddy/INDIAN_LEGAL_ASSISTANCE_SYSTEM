"""Web scraping fallback for legal queries when RAG database has no results.

Scrapes Indian Kanoon (indiankanoon.org) — the largest free Indian legal
case-law and statute database — to find relevant legal information for
the user's personal or general queries.
"""

from __future__ import annotations

import re
from typing import Optional

import httpx
from bs4 import BeautifulSoup

from models import Citation

# ── Configuration ────────────────────────────────────────────────

INDIAN_KANOON_SEARCH = "https://indiankanoon.org/search/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-IN,en;q=0.9",
}
TIMEOUT = 12.0
MAX_RESULTS = 6


# ── Helpers ──────────────────────────────────────────────────────


def _clean_text(text: str, limit: int = 900) -> str:
    """Collapse whitespace and truncate."""
    clean = re.sub(r"\s+", " ", text).strip()
    return clean[:limit] + "…" if len(clean) > limit else clean


def _extract_act_name(title: str) -> str:
    """Try to extract an Act name from a result title."""
    # Many Indian Kanoon results are titled like "Section 420 in The Indian Penal Code"
    match = re.search(r"(?:in|of|under)\s+(.+)", title, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return title.strip()


def _extract_section(title: str) -> Optional[str]:
    """Try to pull a section number from the title."""
    match = re.search(r"Section\s+([\d\w.-]+)", title, re.IGNORECASE)
    return match.group(1) if match else None


# ── Main scraping function ───────────────────────────────────────


async def scrape_legal_info(query: str) -> list[Citation]:
    """Search Indian Kanoon for the query and return parsed citations.

    Returns an empty list on any error (network, parsing, etc.) so the
    caller can fall through to the next fallback gracefully.
    """
    if not query or not query.strip():
        return []

    try:
        print(f"[web_scraper] Searching Indian Kanoon for: {query[:80]}...")

        async with httpx.AsyncClient(
            timeout=TIMEOUT, headers=HEADERS, follow_redirects=True
        ) as client:
            response = await client.get(
                INDIAN_KANOON_SEARCH,
                params={"formInput": query, "pagenum": 0},
            )

        if response.status_code != 200:
            print(f"[web_scraper] Indian Kanoon returned HTTP {response.status_code}")
            return []

        soup = BeautifulSoup(response.text, "lxml")

        # Indian Kanoon wraps each result in a div with class "result"
        result_divs = soup.select("div.result")
        if not result_divs:
            # Fallback: try finding result titles directly
            result_divs = soup.select("div.result_title")
            if not result_divs:
                print("[web_scraper] No results found on Indian Kanoon")
                return []

        citations: list[Citation] = []

        for i, div in enumerate(result_divs[:MAX_RESULTS]):
            try:
                # Title link
                title_tag = div.select_one("a.result_title") or div.select_one("a")
                if not title_tag:
                    continue

                title = title_tag.get_text(strip=True)
                href = title_tag.get("href", "")
                if href and not href.startswith("http"):
                    href = f"https://indiankanoon.org{href}"

                # Snippet / excerpt text
                snippet_tag = div.select_one("div.result_text") or div.select_one(
                    "div.headline"
                )
                if snippet_tag:
                    excerpt = _clean_text(snippet_tag.get_text(" ", strip=True), 800)
                else:
                    excerpt = _clean_text(title, 400)

                # Skip very short / useless results
                if len(excerpt) < 30:
                    continue

                act_name = _extract_act_name(title) if title else "Indian Kanoon"
                section = _extract_section(title)

                citations.append(
                    Citation(
                        index=len(citations) + 1,
                        actName=act_name,
                        section=section,
                        year=None,
                        sourceUrl=str(href) if href else "https://indiankanoon.org/",
                        excerpt=excerpt,
                        origin="webscrape",
                        score=None,
                    )
                )
            except Exception as e:
                print(f"[web_scraper] Error parsing result {i}: {e}")
                continue

        print(f"[web_scraper] Extracted {len(citations)} citations from Indian Kanoon")
        return citations

    except httpx.TimeoutException:
        print("[web_scraper] Indian Kanoon request timed out")
        return []
    except Exception as e:
        print(f"[web_scraper] Scraping failed: {e}")
        return []
