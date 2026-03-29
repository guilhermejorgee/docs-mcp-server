# Semantic Chunking

## Overview

Semantic chunking is an optional content splitting strategy that uses sentence embeddings and cosine similarity to detect topic boundaries in documents. When enabled, content is split where the semantic similarity between adjacent sentences drops below a threshold — producing chunks that align with natural topic shifts rather than structural markers like headings or code blocks.

> **Note:** Embeddings are used transiently during indexing for semantic chunking. They are **not** stored and do **not** affect search ranking. Search is powered by PostgreSQL full-text search (FTS).

## How It Works

The `SemanticChunkingStrategy` operates as follows:

1. **Sentence embedding**: Each sentence in the document is embedded using the configured embedding model (OpenAI, Ollama, Gemini, etc.), producing a vector representation.
2. **Cosine similarity**: Similarity is computed between consecutive sentences. Where similarity drops significantly, a topic boundary is detected.
3. **Chunk formation**: Sentences are grouped into chunks at detected boundaries, producing semantically coherent units.
4. **Transient vectors**: Once chunks are formed, the embedding vectors are discarded. Only the chunked text content is stored in PostgreSQL.

## When It Activates

Semantic chunking activates when **both** conditions are met:

- `chunkingStrategy: "semantic"` is set in configuration (or `--chunking-strategy semantic` CLI flag)
- An embedding model is configured (e.g., `OPENAI_API_KEY` is set)

If `chunkingStrategy` is `"semantic"` but no embedding model is configured, the system falls back to structural chunking and logs a warning.

## Contrast with Structural Chunking

| Aspect | Structural (`"structural"`) | Semantic (`"semantic"`) |
|---|---|---|
| Split boundary | Markdown headings, code blocks, list items | Detected topic shifts via cosine similarity |
| Requires embedding model | No | Yes |
| Cost | Free, zero API calls | Requires embedding API call per page |
| Determinism | Fully deterministic | Depends on model outputs |
| Output quality | Good for well-structured docs | Better for dense prose or poorly-structured content |

**Default:** When no embedding model is configured, the server uses structural chunking automatically.

## Why Embeddings Are Transient

Embeddings serve as a *splitting tool*, not as a search index. After chunking is complete:

- Embedding vectors are **not written to the database**
- They play **no role in search ranking**
- Search is performed exclusively via PostgreSQL `tsvector` full-text search

This means you can freely change or remove your embedding model without affecting existing indexed content or search quality. If you change the model, re-indexing will produce different chunk boundaries, but search functionality remains intact throughout.

## Tradeoffs

**Pros:**
- Produces topic-coherent chunks, especially beneficial for dense prose without structural markup
- Can improve search recall by keeping related ideas together within a single chunk

**Cons:**
- Requires an external embedding API (cost, latency, availability dependency)
- Indexing is slower — one embedding call per page (or batch of sentences)
- Non-deterministic: same content may chunk differently across model versions

## Configuration

Set in `~/.config/docs-mcp-server/config.yaml`:

```yaml
splitter:
  chunkingStrategy: "semantic"   # or "structural" (default)
```

Or via environment variable:

```
DOCS_MCP_SPLITTER_CHUNKING_STRATEGY=semantic
```

See **[Configuration Reference](../setup/configuration.md)** for all `splitter` options and **[Embedding Models](../guides/embedding-models.md)** for provider setup.
