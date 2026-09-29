"""Test BM25 search with the actual pickle data structure."""
import pickle, os
from rank_bm25 import BM25Okapi

bm25_path = '../storage/derived/bm25'

# Load constitution index
pkl = os.path.join(bm25_path, 'constitution_bm25.pkl')
with open(pkl, 'rb') as f:
    data = pickle.load(f)

print(f"Keys: {list(data.keys())}")
print(f"Corpus length: {len(data['corpus'])}")
print(f"IDs length: {len(data['ids'])}")
print(f"First corpus entry (first 20 tokens): {data['corpus'][0][:20]}")
print(f"First ID: {data['ids'][0]}")
print()

# Build BM25 from the pre-tokenized corpus
corpus = data['corpus']
bm25 = BM25Okapi(corpus)

# Search for "article 19"
query = "article 19"
tokenized_query = query.lower().split()
print(f"Query tokens: {tokenized_query}")

scores = bm25.get_scores(tokenized_query)
top_indices = scores.argsort()[-5:][::-1]

print(f"\nTop 5 results for '{query}':")
for rank, idx in enumerate(top_indices):
    score = scores[idx]
    doc_text = ' '.join(corpus[idx][:30])  # first 30 tokens
    doc_id = data['ids'][idx] if idx < len(data['ids']) else 'unknown'
    print(f"  [{rank+1}] score={score:.4f}")
    print(f"       id={doc_id}")
    print(f"       text={doc_text[:120]}...")
    print()
