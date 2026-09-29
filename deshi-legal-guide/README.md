# NyayaSahay — Legal Advisory System

An AI-powered Indian legal advisory platform with RAG (Retrieval-Augmented Generation).

## Architecture

- **Backend** (`backend/`): Python FastAPI — ChromaDB + BM25 hybrid RAG, OpenRouter LLM streaming, SQLite chat storage
- **Frontend** (`deshi-legal-guide/`): React + TanStack — modern glassmorphism UI with SSE streaming chat

## Quick Start

### Terminal 1 — Backend
```bash
cd backend
pip install -r requirements.txt
python main.py
```

### Terminal 2 — Frontend
```bash
cd deshi-legal-guide
npm run dev
```

### API Key
Add your OpenRouter API key in `backend/.env`:
```env
OPENROUTER_API_KEY=sk-or-v1-your-key-here
```

## Features

- Hybrid RAG retrieval (ChromaDB vector search + BM25 keyword search + RRF fusion)
- India Code API fallback for broader legal coverage
- Real-time streaming answers with citations
- Multi-language support
- Legal document generation
- Case/matter management
