# NyayaSahay (LexAI): Indian Legal Assistance System

## Project Documentation

**Version:** 1.0  
**Date:** September 2026  
**Platform:** Web Application (Desktop & Mobile Responsive)

---

## Table of Contents

1. [Design Stage (System Architecture and UML Diagrams)](#1-design-stage-system-architecture-and-uml-diagrams)
2. [Data Collection](#2-data-collection)
3. [Implementation on User Interface](#3-implementation-on-user-interface)
4. [Code Implementation](#4-code-implementation)

---

## 1. Design Stage (System Architecture and UML Diagrams)

The NyayaSahay platform follows a modern, decoupled client–server architecture. A **React / TanStack Start** frontend communicates with a **Python FastAPI** backend over REST and SSE (Server-Sent Events). The backend employs a **Tiered Hybrid Retrieval-Augmented Generation (RAG)** strategy — local-first for privacy and speed, with intelligent fallback to external legal sources.

### 1.1 High-Level System Architecture

```mermaid
graph TD
    subgraph Client ["Client Layer"]
        Browser["Web Browser"]
    end

    subgraph Frontend ["Frontend — React / TanStack Start"]
        Landing["Landing Page"]
        ChatUI["Chat Interface"]
        DocUI["Document Drafting"]
        LibUI["Library / Corpus Browser"]
        MatterUI["Case Matters Manager"]
        LangProv["Language Provider (i18n — 12 Languages)"]
    end

    subgraph Backend ["Backend — Python FastAPI"]
        API["FastAPI Gateway"]
        RAGEngine["Hybrid RAG Engine"]
        LLMService["LLM Service (Gemini 2.5 Flash)"]
        PromptEngine["Prompt Engine (NyayaSahay)"]
        DBService["SQLite Database Service"]
    end

    subgraph DataSources ["Data Sources — Tiered Retrieval"]
        ChromaDB[("ChromaDB\n(Dense Vector Store)")]
        BM25[("BM25 Indexes\n(Sparse Keyword)")]
        IKScraper["Indian Kanoon\nWeb Scraper"]
        IndiaCode["India Code API"]
    end

    subgraph LLM ["External AI Service"]
        GeminiAPI["Google Gemini API\n(AI Studio)"]
    end

    Browser <-->|HTTP / SSE| API
    Browser -.-> Frontend
    API --> RAGEngine
    API --> LLMService
    API --> DBService
    RAGEngine --> ChromaDB
    RAGEngine --> BM25
    RAGEngine -.->|Fallback Tier 2| IKScraper
    RAGEngine -.->|Fallback Tier 3| IndiaCode
    LLMService --> GeminiAPI
    RAGEngine --> PromptEngine
    PromptEngine --> LLMService
```

### 1.2 Tiered Retrieval Pipeline Architecture

The retrieval system uses a confidence-gated tiered fallback approach to guarantee factual, grounded responses while eliminating hallucination.

```mermaid
flowchart TD
    A["User Query"] --> B["Query Pre-processing\n(Keyword Extraction)"]
    B --> C{"Tier 1: Local RAG\n(ChromaDB Dense + BM25 Sparse)"}

    C --> D["Dense Search\n(Gemini Embeddings via ChromaDB)"]
    C --> E["Sparse Search\n(BM25Okapi Keyword Matching)"]

    D --> F["Reciprocal Rank Fusion\n(RRF, k=60)"]
    E --> F

    F --> G{"Confidence Score ≥ Threshold?"}

    G -->|Yes — HIGH Confidence| H["Return LOCAL Citations\nGrounding: corpus"]

    G -->|No — LOW Confidence| I{"Tier 2: Web Scraping\n(Indian Kanoon)"}

    I -->|Results Found| J["Return Web Citations\nGrounding: webscrape"]
    I -->|No Results| K{"Tier 3: India Code API"}

    K -->|Results Found| L["Return API Citations\nGrounding: indiacode"]
    K -->|No Results| M["Return General Guidance\nGrounding: none"]

    H --> N["Build Context + System Prompt"]
    J --> N
    L --> N
    M --> N

    N --> O["LLM Streaming Inference\n(Gemini 2.5 Flash)"]
    O --> P["SSE Token Stream → Frontend"]

    style A fill:#1a1a2e,color:#e0e0e0
    style H fill:#0d4d0d,color:#e0e0e0
    style J fill:#4d3d0d,color:#e0e0e0
    style L fill:#0d2d4d,color:#e0e0e0
    style M fill:#4d0d0d,color:#e0e0e0
```

### 1.3 UML Sequence Diagram — Chat Query Lifecycle

This sequence diagram illustrates the complete end-to-end lifecycle of a user submitting a legal query and receiving a streamed, citation-grounded response.

```mermaid
sequenceDiagram
    actor User
    participant UI as Chat UI (React)
    participant API as FastAPI Router
    participant DB as SQLite Database
    participant RAG as Hybrid RAG Engine
    participant Chroma as ChromaDB (Dense)
    participant BM25 as BM25 Indexes (Sparse)
    participant RRF as RRF Fusion
    participant Scraper as Indian Kanoon Scraper
    participant LLM as Google Gemini API

    User->>UI: Types legal question
    UI->>API: POST /api/chat {message, sessionId, threadId, language}

    API->>DB: get_or_create_thread(sessionId, threadId)
    DB-->>API: threadId

    API->>DB: add_message(threadId, "user", message)

    API->>DB: get_history(threadId)
    DB-->>API: Previous conversation turns

    API->>RAG: retrieve_context(question)

    par Dense + Sparse Search
        RAG->>Chroma: Query with Gemini embeddings (top 8)
        Chroma-->>RAG: Dense results with similarity scores
        RAG->>BM25: Keyword search across all indexes (top 8)
        BM25-->>RAG: Sparse results with BM25 scores
    end

    RAG->>RRF: Fuse results (k=60, top_n=8)
    RRF-->>RAG: Ranked citations

    alt High Confidence (score ≥ threshold)
        RAG-->>API: RetrievalResult {citations, context, grounding="corpus"}
    else Low Confidence — Fallback
        RAG->>Scraper: scrape_legal_info(query)
        Scraper-->>RAG: Web citations from Indian Kanoon
        RAG-->>API: RetrievalResult {citations, context, grounding="webscrape"}
    end

    API-->>UI: SSE Frame: {type: "meta", threadId, citations, grounding}

    API->>LLM: Stream inference (system_prompt + history + context)

    loop Token Streaming
        LLM-->>API: Yield text delta
        API-->>UI: SSE Frame: {type: "delta", text}
        UI-->>User: Render token in real-time
    end

    API->>DB: add_message(threadId, "assistant", answer, citations, grounding)
    API->>LLM: Generate title (for new threads)
    API->>DB: update_thread_title(threadId, title)
    API-->>UI: SSE Frame: {type: "done", title}
    UI-->>User: Display complete answer with citations
```

### 1.4 UML Class Diagram — Backend Data Models

```mermaid
classDiagram
    class ChatRequest {
        +str sessionId
        +Optional~str~ threadId
        +Optional~str~ matterId
        +str message
        +str language
    }

    class Citation {
        +int index
        +str actName
        +Optional~str~ section
        +Optional~int~ year
        +Optional~str~ sourceUrl
        +str excerpt
        +Literal origin
        +Optional~float~ score
    }

    class RetrievalResult {
        +list~Citation~ citations
        +str context
        +Literal grounding
    }

    class ThreadSummary {
        +str id
        +str title
        +str language
        +Optional~str~ matterId
        +str updatedAt
    }

    class ChatTurn {
        +str id
        +Literal role
        +str content
        +list~Citation~ citations
        +Literal grounding
        +str createdAt
    }

    ChatRequest ..> RetrievalResult : triggers retrieval
    RetrievalResult *-- Citation : contains 0..*
    ChatTurn *-- Citation : contains 0..*
    ThreadSummary "1" --> "0..*" ChatTurn : contains turns
```

### 1.5 Deployment Diagram

```mermaid
graph LR
    subgraph UserMachine ["User Machine"]
        Browser["Web Browser\n(Chrome / Edge / Firefox)"]
    end

    subgraph Server ["Development / Local Server"]
        subgraph FrontendServer ["Frontend Server"]
            Vite["Vite Dev Server\n(port 3000)"]
        end
        subgraph BackendServer ["Backend Server"]
            Uvicorn["Uvicorn + FastAPI\n(port 8000)"]
        end
        subgraph Storage ["Local Storage"]
            SQLite[("SQLite DB\nchat.db")]
            ChromaStore[("ChromaDB\nVector Store")]
            BM25Files[("BM25 Pickle\nIndexes")]
        end
    end

    subgraph ExternalServices ["External Services"]
        Gemini["Google AI Studio\nGemini 2.5 Flash"]
        IK["indiankanoon.org"]
        IC["India Code API"]
    end

    Browser <-->|HTTP| Vite
    Vite <-->|Proxy /api| Uvicorn
    Uvicorn <--> SQLite
    Uvicorn <--> ChromaStore
    Uvicorn <--> BM25Files
    Uvicorn <-->|HTTPS| Gemini
    Uvicorn <-.->|HTTPS fallback| IK
    Uvicorn <-.->|HTTPS fallback| IC
```

### 1.6 Component Diagram — Frontend Module Structure

```mermaid
graph TD
    subgraph AppShell ["Application Shell"]
        Nav["Navigation Bar"]
        LangPicker["Language Picker"]
    end

    subgraph Pages ["Route Pages"]
        Home["/ — Landing Page"]
        Chat["/chat — AI Legal Chat"]
        Documents["/documents — Document Drafting"]
        Library["/library — Legal Corpus Browser"]
        Matters["/matters — Case Manager"]
    end

    subgraph SharedComponents ["Shared UI Components"]
        MarkdownText["Markdown Renderer"]
        UIKit["Radix UI Primitives\n(Buttons, Sheets, Cards, etc.)"]
    end

    subgraph Services ["Frontend Services"]
        ChatFn["chat.functions.ts"]
        DocFn["documents.functions.ts"]
        CorpusFn["corpus.functions.ts"]
        MatterFn["matters.functions.ts"]
        SessionMgr["session.ts"]
        I18N["i18n.ts (12 Languages)"]
    end

    AppShell --> Pages
    Pages --> SharedComponents
    Pages --> Services
    Chat --> ChatFn
    Documents --> DocFn
    Library --> CorpusFn
    Matters --> MatterFn
```

---

## 2. Data Collection

The strength of NyayaSahay lies in its massive, highly curated local semantic knowledge base, optimised for offline functionality and low-latency retrieval.

### 2.1 Dataset Overview

| Dataset | Size | Description |
|---------|------|-------------|
| Supreme Court Judgments | **33,016 judgments** | Decades of jurisprudence spanning landmark cases, precedent-setting verdicts, and appellate decisions |
| Constitution of India | Full text | All Articles, Schedules, and Amendments |
| Bharatiya Nyaya Sanhita (BNS) | Full text | Replaced Indian Penal Code (IPC) — new criminal law provisions |
| Bharatiya Nagarik Suraksha Sanhita (BNSS) | Full text | Replaced CrPC — new procedural framework |
| Central Acts | Comprehensive | Updated compendium of central legislation |

### 2.2 Ingestion Pipeline

```mermaid
flowchart LR
    A["Raw Legal Documents\n(PDFs, Text Files, Datasets)"] --> B["Document Parsing\n& Chunking"]
    B --> C["Semantic Chunking\nwith Contextual Overlap"]
    C --> D["Vector Embedding\n(Gemini Embeddings)"]
    D --> E[("ChromaDB\nVector Store")]
    C --> F["BM25 Tokenization\n& Corpus Building"]
    F --> G[("BM25 Pickle\nIndexes")]

    style A fill:#1a1a2e,color:#e0e0e0
    style E fill:#0d4d0d,color:#e0e0e0
    style G fill:#0d2d4d,color:#e0e0e0
```

### 2.3 Ingestion Pipeline Steps

1. **Document Parsing & Chunking**  
   Raw legal texts (PDFs, JSONL datasets, plain text) are parsed automatically. Complex document structures — nested articles, section headings, provisos, and explanations — are flattened and segmented into logical semantic chunks with contextual overlap to ensure no legal provision is split across chunk boundaries.

2. **Vector Embedding (Dense Index)**  
   Each chunk is embedded using **Google Gemini Embeddings** (model: `text-embedding-004`, 768 dimensions). Embeddings are processed in optimised batch sizes for high-throughput sequential-to-pipelined indexing. Hardware-aware execution ensures stability on local machines.

3. **BM25 Indexing (Sparse Index)**  
   In parallel, chunks are tokenised into word-level corpora and indexed using the **BM25Okapi** algorithm. Pre-built BM25 indexes are serialised as Python pickle files for instant load on server startup. Each collection (Constitution, BNS, Central Acts, Supreme Court Judgments) gets its own BM25 index.

4. **Metadata Enrichment**  
   Every chunk is stored alongside rich metadata — Act name, section numbers, article references, judgment citations, year, and source file paths — enabling precise citation generation in AI responses.

5. **Storage Architecture**  
   - **ChromaDB**: Local vector database storing dense embeddings alongside document metadata. Supports cosine similarity search.
   - **BM25 Pickle Files**: Serialised sparse indexes loaded into memory at startup for sub-millisecond keyword retrieval.
   - **SQLite**: Lightweight relational database for chat threads, messages, and user session persistence.

### 2.4 Data Collection from External Sources (Fallback)

```mermaid
flowchart TD
    subgraph Tier2 ["Tier 2 — Indian Kanoon Web Scraper"]
        IK1["HTTP GET to indiankanoon.org/search"]
        IK2["HTML Parsing\n(BeautifulSoup + lxml)"]
        IK3["Citation Extraction\n(Act Name, Section, Excerpt, URL)"]
        IK1 --> IK2 --> IK3
    end

    subgraph Tier3 ["Tier 3 — India Code API"]
        IC1["API Request to\nIndia Code Register"]
        IC2["Response Parsing\n(JSON / XML)"]
        IC3["Citation Construction\n(Act, Section, Text)"]
        IC1 --> IC2 --> IC3
    end

    IK3 --> R["Citations returned to RAG Engine"]
    IC3 --> R

    style Tier2 fill:#4d3d0d,color:#e0e0e0
    style Tier3 fill:#0d2d4d,color:#e0e0e0
```

| Source | Type | Purpose | Trigger |
|--------|------|---------|---------|
| Indian Kanoon | Web Scraping (HTML) | Largest free Indian legal database — case law, statutes, and judgments | Local RAG confidence below threshold |
| India Code | Public API | Official central government register of all Indian Acts | No results from Indian Kanoon |

---

## 3. Implementation on User Interface

The frontend is built with **React 19**, **TanStack Start/Router**, and **TailwindCSS 4**, using **Radix UI** primitives for accessible, professional components. The design follows a **glassmorphism aesthetic** with a dark colour scheme.

### 3.1 Frontend Technology Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| React | 19.2 | UI rendering framework |
| TanStack Start | 1.168.32 | Full-stack React framework with file-based routing |
| TanStack Router | 1.170.18 | Type-safe client-side routing |
| TanStack React Query | 5.x | Server state management and data caching |
| Vite | 8.1.5 | Build tool and dev server |
| TailwindCSS | 4.2.1 | Utility-first CSS framework |
| Radix UI | Latest | Headless, accessible component primitives |
| Lucide React | 0.575 | Icon library |
| Zod | 3.25 | Runtime type validation |
| Sonner | 2.0 | Toast notifications |
| TypeScript | 5.8 | Static type safety |

### 3.2 Application Page Map

```mermaid
graph TD
    Root["/ — Root Layout\n(AppShell + Navigation)"]
    Root --> Home["/ — Landing Page\n• Hero section with CTA\n• Feature cards\n• Legal disclaimer"]
    Root --> Chat["/chat — AI Legal Chat\n• Thread sidebar\n• Real-time SSE streaming\n• Citation panel\n• Language picker"]
    Root --> Docs["/documents — Document Drafting\n• Template selection\n• Dynamic form builder\n• PDF generation"]
    Root --> Library["/library — Legal Library\n• Corpus browser\n• Full-text search"]
    Root --> Matters["/matters — Case Manager\n• Case file management\n• Linked consultations"]
```

### 3.3 Chat Interface — Detailed UI Architecture

The chat page is the core interaction surface. It provides a multi-turn, streaming conversation experience grounded in legal citations.

```mermaid
graph TD
    subgraph ChatPage ["Chat Page Layout"]
        subgraph Sidebar ["Left Sidebar (Desktop)"]
            NewBtn["+ New Consultation Button"]
            ThreadList["Thread List\n(ScrollArea with delete)"]
        end

        subgraph MainArea ["Main Chat Area"]
            Header["Thread Title + Language Picker"]
            Messages["Message Stream\n(User bubbles / Assistant cards)"]
            SourceBadge["Grounding Badge\n(corpus / webscrape / indiacode)"]
            Input["Textarea + Send Button"]
            Disclaimer["Legal disclaimer footer"]
        end

        subgraph SourcePanel ["Sources Sheet (Slide-out)"]
            CitationCards["Citation Cards\n• Act Name + Section\n• Excerpt text\n• Source URL link"]
        end
    end

    Sidebar --> MainArea
    MainArea --> SourcePanel

    style ChatPage fill:#1a1a2e,color:#e0e0e0
```

### 3.4 Key UI Features

1. **Real-Time Token Streaming (SSE)**
   - Messages are rendered token-by-token as they arrive from the backend via Server-Sent Events
   - A loading spinner with "Thinking…" text displays during the RAG retrieval phase
   - Automatic scroll-to-bottom keeps the latest content visible

2. **Citation Verification System**
   - Each AI response includes a grounding badge (`From indexed Acts`, `From legal websites`, `General guidance`)
   - Clicking "Sources (N)" opens a slide-out panel with detailed citation cards
   - Each citation shows: Act name, Section number, Excerpt text, and a link to the original source

3. **Conversation Management**
   - Thread sidebar with CRUD operations (Create, Read, Delete)
   - Auto-generated titles via LLM after the first exchange
   - Persistent sessions using browser-generated UUIDs stored in localStorage
   - Conversation history maintained in SQLite with up to 24 recent turns

4. **Multilingual Support (12 Languages)**
   - Built-in i18n system with translations for: English, Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Odia, and Urdu
   - Language picker accessible from the chat header
   - System prompts adapt dynamically to the selected language

5. **Responsive Design**
   - Thread sidebar collapses on mobile; a floating "New" button appears instead
   - Chat bubbles adapt max-width for readability
   - Full keyboard support (Enter to send, Shift+Enter for newline)

### 3.5 UI Data Flow — SSE Streaming

```mermaid
sequenceDiagram
    participant User
    participant ReactState as React State
    participant FetchAPI as Fetch API
    participant Backend as FastAPI

    User->>ReactState: setDraft(message)
    User->>ReactState: send() — clear draft, set streaming=true
    ReactState->>FetchAPI: POST /api/chat (body: JSON)
    FetchAPI->>Backend: HTTP Request

    Backend-->>FetchAPI: SSE Frame {type: "meta", threadId, citations}
    FetchAPI-->>ReactState: applyToAssistant() — set citations + grounding

    loop Token-by-Token
        Backend-->>FetchAPI: SSE Frame {type: "delta", text: "The"}
        FetchAPI-->>ReactState: applyToAssistant() — append text
        ReactState-->>User: Re-render with new token
    end

    Backend-->>FetchAPI: SSE Frame {type: "done", title}
    FetchAPI-->>ReactState: Invalidate queries, navigate to thread
    ReactState-->>User: Show complete response + citations
```

---

## 4. Code Implementation

NyayaSahay's codebase is organized into two main modules: a Python FastAPI backend and a TypeScript/React frontend. Below is a detailed breakdown of the core implementation.

### 4.1 Backend Architecture

```mermaid
graph TD
    subgraph BackendFiles ["Backend Module Structure"]
        Main["main.py\n— FastAPI App + Routes"]
        Retrieval["retrieval.py\n— Hybrid RAG Engine"]
        LLM["llm.py\n— Gemini API Streaming"]
        Database["database.py\n— SQLite Persistence"]
        Models["models.py\n— Pydantic Schemas"]
        Prompts["prompts.py\n— System Prompt Builder"]
        WebScraper["web_scraper.py\n— Indian Kanoon Scraper"]
    end

    Main --> Retrieval
    Main --> LLM
    Main --> Database
    Main --> Models
    Main --> Prompts
    Retrieval --> WebScraper
    Retrieval --> Models
    Database --> Models
    Prompts --> LLM

    style Main fill:#2d1b69,color:#e0e0e0
    style Retrieval fill:#1b4d3e,color:#e0e0e0
```

### 4.2 Backend Module Details

#### 4.2.1 `main.py` — FastAPI Gateway (222 lines)

The application entry point that defines all API endpoints and orchestrates the request lifecycle.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat` | POST | SSE streaming legal chat (RAG + LLM) |
| `/api/threads` | GET | List conversation threads for a session |
| `/api/threads/{id}` | GET | Get a thread with all messages |
| `/api/threads/{id}` | DELETE | Delete a conversation thread |
| `/api/health` | GET | Backend health check |

**Key Implementation Details:**
- CORS middleware allows all origins for development
- Chat endpoint returns `StreamingResponse` with `text/event-stream` media type
- SSE frames follow a structured JSON protocol with types: `meta`, `delta`, `done`, `error`
- Auto-generates conversation titles after first exchange using LLM

#### 4.2.2 `retrieval.py` — Hybrid RAG Engine (466 lines)

The core intelligence module implementing a dual-index search with confidence-based fallback.

**Key Functions:**

```
retrieve_context(question)        → Main entry point: orchestrates tiered retrieval
_search_chroma(question, n=8)     → Dense search across all ChromaDB collections
_search_bm25(question, n=8)       → Sparse keyword search across BM25 indexes
_rrf_fuse(dense, sparse, k=60)    → Reciprocal Rank Fusion merger
_get_gemini_embedding(text)       → Generate embeddings via Google API
_search_indiacode(question)       → India Code API fallback
_build_context(citations)         → Format citations into LLM-ready context
```

**Retrieval Strategy:**
1. Execute **dense search** (ChromaDB with Gemini embeddings) and **sparse search** (BM25Okapi) in parallel
2. Merge results using **Reciprocal Rank Fusion (RRF)** with parameter k=60
3. If top results exceed confidence threshold → return with `grounding="corpus"`
4. If below threshold → fall through to **web scraping** (Indian Kanoon)
5. If web scraping fails → fall through to **India Code API**
6. If all sources fail → return `grounding="none"` for general guidance

#### 4.2.3 `llm.py` — LLM Streaming Service (111 lines)

Handles communication with Google Gemini API for text generation.

- **Model**: Gemini 2.5 Flash (configurable via environment variable)
- **Streaming**: Uses `httpx.AsyncClient` with SSE streaming for real-time token delivery
- **Message Format Conversion**: Translates OpenAI-style messages (`user`, `assistant`, `system`) to Gemini's native format (`user`, `model`, `system_instruction`)
- **Configuration**: Temperature 0.7, max output tokens 4096

#### 4.2.4 `database.py` — SQLite Persistence (220 lines)

Manages chat thread and message persistence using raw SQLite with WAL mode for concurrent access.

**Schema:**

```sql
CREATE TABLE chat_threads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'New consultation',
    language TEXT NOT NULL DEFAULT 'en',
    matter_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '[]',
    grounding TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL
);
```

#### 4.2.5 `models.py` — Pydantic Schemas (50 lines)

Type-safe data validation models used across the backend:

- `ChatRequest` — Incoming chat message with session/thread context
- `Citation` — A single legal citation with act name, section, excerpt, origin, and score
- `RetrievalResult` — Bundle of citations + context string + grounding source type
- `ThreadSummary` — Lightweight thread listing (id, title, language, timestamp)
- `ChatTurn` — A single message in a conversation with role, content, and citations

#### 4.2.6 `prompts.py` — System Prompt Builder (124 lines)

Constructs dynamic, context-aware system prompts for the NyayaSahay persona.

**Prompt Adaptation by Grounding Source:**

| Grounding | Prompt Strategy |
|-----------|-----------------|
| `corpus` | Instructs LLM to use local passages as primary reference with bracketed citations |
| `webscrape` | Instructs LLM to acknowledge Indian Kanoon as source and share source URLs |
| `indiacode` | Instructs LLM to reference India Code provisions |
| `none` | Instructs LLM to provide general guidance with disclaimer and recommend legal aid |

The NyayaSahay persona is configured as both a general legal information resource and a personal legal advisor — analysing specific facts, identifying applicable laws, and suggesting practical next steps (forum, documents, timelines).

#### 4.2.7 `web_scraper.py` — Indian Kanoon Scraper (152 lines)

An asynchronous web scraper that queries `indiankanoon.org` as a fallback data source.

- Uses `httpx` for async HTTP requests with 12-second timeouts
- Parses HTML using `BeautifulSoup` with `lxml` parser
- Extracts up to 6 citations per query: Act name, section number, excerpt, and source URL
- Gracefully returns empty results on any error (network, parsing) to allow further fallback

### 4.3 Frontend Module Structure

| Module | Lines | Description |
|--------|-------|-------------|
| `routes/index.tsx` | 149 | Landing page with hero section, feature cards, and legal disclaimer |
| `routes/chat.tsx` | 473 | Full chat interface with thread management, SSE streaming, and citation panel |
| `routes/documents.tsx` | 16,674 bytes | Document drafting with template selection and dynamic forms |
| `routes/library.tsx` | 13,982 bytes | Legal corpus browser with full-text search |
| `routes/matters.tsx` | 8,900 bytes | Case file manager with linked consultations |
| `lib/chat.functions.ts` | 3,474 bytes | Backend API client for chat thread CRUD |
| `lib/i18n.ts` | 11,927 bytes | Internationalisation strings for 12 Indian languages |
| `lib/legal.ts` | 4,889 bytes | Legal type definitions and utilities |
| `components/markdown-text.tsx` | 3,584 bytes | Markdown renderer with citation link interception |

### 4.4 Key Dependencies

#### Backend (Python)

| Package | Version | Purpose |
|---------|---------|---------|
| FastAPI | 0.115.12 | Web framework for REST APIs |
| Uvicorn | 0.34.3 | ASGI server |
| ChromaDB | 0.6.3 | Vector database for dense embeddings |
| rank-bm25 | 0.2.2 | BM25Okapi sparse retrieval |
| httpx | 0.28.1 | Async HTTP client (for Gemini API + web scraping) |
| Pydantic | 2.11.3 | Data validation and serialisation |
| BeautifulSoup4 | 4.13.4 | HTML parsing for Indian Kanoon scraping |
| lxml | 5.4.0 | Fast XML/HTML parser backend |
| python-dotenv | 1.1.0 | Environment variable management |

#### Frontend (TypeScript)

| Package | Version | Purpose |
|---------|---------|---------|
| React | 19.2.0 | UI rendering |
| TanStack Router | 1.170.18 | File-based routing with type safety |
| TanStack React Query | 5.x | Server state management |
| TailwindCSS | 4.2.1 | Utility-first CSS |
| Radix UI | Latest | Accessible component primitives |
| Zod | 3.25 | Runtime schema validation |
| Vite | 8.1.5 | Build tool with HMR |

### 4.5 End-to-End Request Flow — Code Walkthrough

```mermaid
flowchart LR
    subgraph Step1 ["1. User Input"]
        UI["chat.tsx\nsend() callback"]
    end

    subgraph Step2 ["2. API Gateway"]
        API["main.py\nchat_endpoint()"]
    end

    subgraph Step3 ["3. Persistence"]
        DB["database.py\nadd_message()\nget_history()"]
    end

    subgraph Step4 ["4. Retrieval"]
        RAG["retrieval.py\nretrieve_context()"]
    end

    subgraph Step5 ["5. Prompt Build"]
        Prompt["prompts.py\nlegal_system_prompt()"]
    end

    subgraph Step6 ["6. LLM Stream"]
        LLM["llm.py\nstream_answer()"]
    end

    subgraph Step7 ["7. Response"]
        SSE["SSE Frames\nmeta → delta* → done"]
    end

    Step1 -->|POST /api/chat| Step2
    Step2 --> Step3
    Step3 --> Step4
    Step4 --> Step5
    Step5 --> Step6
    Step6 --> Step7
    Step7 -->|Token stream| Step1
```

---

*This document was prepared for academic and development reference purposes for the NyayaSahay Indian Legal Assistance System project.*
