# AI, memories and semantic search

Production Kody uses Workers AI / AI Gateway for chat and embeddings and
Vectorize for memory search. kody-celld replaces them with **adapters you
point at any model server** plus a **built-in vector store**; nothing here
requires a cloud account. With no configuration at all, memories still work and
every search is lexical (SQLite FTS5).

| Piece           | Self-hosted built-in                                   | Adapter(s)                                                                                                   |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Chat (`aiChat`) | —                                                      | any OpenAI-compatible `/chat/completions` (Ollama, LM Studio, vLLM, OpenRouter, OpenAI…), Anthropic Messages |
| Embeddings      | —                                                      | any OpenAI-compatible `/embeddings` (Ollama `nomic-embed-text`, LM Studio, vLLM, OpenAI…)                    |
| Memories        | per-user `MemoryCell` (SQLite + FTS5)                  | —                                                                                                            |
| Vector store    | sqlite-vec `vec0` table inside the same cell (default) | Qdrant (`KODY_VECTOR_PROVIDER=qdrant`)                                                                       |
| Search ranking  | FTS5/lexical, reciprocal-rank fusion with vectors      | optional LLM re-rank of the top hits (`KODY_SEARCH_RERANK=llm`)                                              |

## Configuration

All settings are Worker environment variables (`src/ai/config.ts`); set them in
`.env` for Docker, `.dev.vars` for `celld dev`, or re-run the fleet `deploy`
service. Invalid combinations fail at the first AI call with a clear message and
`GET /admin/ai` shows the parsed result.

| Variable                                                             | Default                                                      | Notes                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `KODY_AI_PROVIDER`                                                   | `none`                                                       | `none`, `openai` (any OpenAI-compatible server) or `anthropic`.                                                                            |
| `KODY_AI_BASE_URL`                                                   | `https://api.openai.com/v1` / `https://api.anthropic.com/v1` | Ollama: `http://host:11434/v1`; LM Studio: `http://host:1234/v1`; vLLM: `http://host:8000/v1`; OpenRouter: `https://openrouter.ai/api/v1`. |
| `KODY_AI_API_KEY`                                                    | —                                                            | Sent as `Authorization: Bearer` (OpenAI-compatible) or `x-api-key` (Anthropic). Optional for local servers; required for Anthropic.        |
| `KODY_AI_CHAT_MODEL`                                                 | `gpt-4o-mini` / `claude-3-5-haiku-latest`                    | Any model id the endpoint accepts (`llama3.2`, `qwen2.5`, …).                                                                              |
| `KODY_AI_EMBED_PROVIDER`                                             | `openai` if the chat provider is `openai`, else `none`       | Anthropic has no embeddings API, so pair it with an explicit embedding endpoint.                                                           |
| `KODY_AI_EMBED_BASE_URL` / `KODY_AI_EMBED_API_KEY`                   | the chat endpoint / key when that is OpenAI-compatible       | Lets you mix e.g. Anthropic chat with Ollama embeddings.                                                                                   |
| `KODY_AI_EMBED_MODEL`                                                | `text-embedding-3-small`                                     | `nomic-embed-text` (768), `mxbai-embed-large` (1024), `all-minilm` (384), …                                                                |
| `KODY_AI_EMBED_DIMENSIONS`                                           | `1536`                                                       | Must match the model's output (1–8192). A mismatch is rejected before anything is stored.                                                  |
| `KODY_AI_TIMEOUT_MS`                                                 | `20000`                                                      | Per provider request (1 ms – 5 min).                                                                                                       |
| `KODY_SEARCH_RERANK`                                                 | `off`                                                        | `llm` asks the chat model to reorder the top 12 hits; requires a chat provider.                                                            |
| `KODY_VECTOR_PROVIDER`                                               | `local`                                                      | `local` (sqlite-vec in the memory cell) or `qdrant`.                                                                                       |
| `KODY_QDRANT_URL` / `KODY_QDRANT_API_KEY` / `KODY_QDRANT_COLLECTION` | — / — / `kody-memories`                                      | Qdrant REST endpoint. One collection holds every user's vectors, filtered by `userId` payload.                                             |

Provider keys are **operator** configuration, read host-side by the memory cell
and the search tool; they are never visible to sandboxed code and never appear
in `aiStatus`, `GET /admin/ai`, results, logs or the audit log (only
`hasApiKey: true/false`). Users who want to call a model from their own
package code keep using `{{secret:…}}` placeholders through the gateway.

### Recipes

**Ollama on the same box (Docker single node)**

```sh
# .env
KODY_AI_PROVIDER=openai
KODY_AI_BASE_URL=http://host.docker.internal:11434/v1
KODY_AI_CHAT_MODEL=llama3.2
KODY_AI_EMBED_MODEL=nomic-embed-text
KODY_AI_EMBED_DIMENSIONS=768
KODY_SEARCH_RERANK=llm
```

**Everything in containers (Ollama + Qdrant next to Kody)**

```sh
echo 'COMPOSE_FILE=compose.yaml:compose.ai.yaml' >> .env
docker compose up -d
docker compose exec ollama ollama pull nomic-embed-text
```

`compose.ai.yaml` defaults Kody to Ollama embeddings (`nomic-embed-text`, 768)
and Qdrant vectors; add `KODY_AI_PROVIDER=openai` + a pulled chat model to turn
on `aiChat` and re-ranking. Set `KODY_VECTOR_PROVIDER=local` to keep vectors in
SQLite instead of Qdrant.

**Hosted models, local vectors**

```sh
KODY_AI_PROVIDER=anthropic
KODY_AI_API_KEY=<your Anthropic key, never committed>
KODY_AI_EMBED_PROVIDER=openai
KODY_AI_EMBED_BASE_URL=https://api.openai.com/v1
KODY_AI_EMBED_API_KEY=<your OpenAI key>
```

**Fleet**: the same variables go in `.env` beside the fleet values; the `deploy`
service renders them into `wrangler.fleet.jsonc`. Run Ollama/Qdrant wherever
you like and use reachable URLs (`http://ollama.lan:11434/v1`).

## Capabilities (all through MCP `search` → `execute`)

| Capability         | What it does                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `aiStatus`         | Which providers/models/stores are configured (no key values).                                                              |
| `aiChat`           | One completion: `prompt` or `messages`, optional `system`, `max_tokens`, `json` (returns the parsed object as `json`).     |
| `aiEmbed`          | Embeddings for 1–32 strings; results are cached by content hash in the user's memory cell.                                 |
| `metaMemoryVerify` | **Run first.** Returns the `dedupe_key` match and related memories with scores so the model can decide upsert/delete/skip. |
| `metaMemoryUpsert` | Create or update (`id` or `dedupe_key`) a memory: subject, summary, details, category, tags, source_uris, status.          |
| `metaMemoryGet`    | One memory by id (touches `last_accessed_at`).                                                                             |
| `metaMemorySearch` | Ranked recall; `ranking` tells you whether the result is `lexical` or `hybrid`.                                            |
| `metaMemoryDelete` | Soft delete (recoverable via `include_deleted`) or `force: true` to hard delete and drop the vector.                       |

Without a chat provider `aiChat` returns `ai_not_configured` (503); without an
embedding provider `aiEmbed` does the same and memory/search silently stay
lexical. Conversation-scoped suppression (`conversation_id`) hides memories the
model already saw in this conversation from later `verify`/`search` calls.

## How ranking works

1. **Lexical.** FTS5 over subject/summary/details/tags/category (memories) or
   token overlap with prefix boosts (capability catalog, guides, packages).
2. **Vectors.** If an embedding provider is configured, the query and candidates
   are embedded (content-hash cache in the user's cell; memories are embedded
   on write) and scored by cosine similarity, from sqlite-vec or Qdrant.
3. **Fusion.** Both rank lists are merged with reciprocal-rank fusion
   (`k = 60`) → `ranking: 'hybrid'`.
4. **Re-rank (optional).** With `KODY_SEARCH_RERANK=llm` the top 12 are sent to
   the chat model, which returns an order as JSON; anything it drops keeps its
   fused position → `ranking: 'hybrid+llm'` / `'lexical+llm'`.
5. **Degrade, never fail.** A provider timeout or a store error falls back to
   the previous stage and adds a `warnings` entry
   (`semantic_unavailable: …`, `rerank_unavailable: …`).

Memory vectors are keyed by embedding model. Changing `KODY_AI_EMBED_MODEL` or
`_DIMENSIONS` recreates the local `vec0` table (or validates the Qdrant
collection size) and marks memories for re-embedding; run
`POST /admin/users/:id/memories/reindex` to embed a user's backlog eagerly;
otherwise each search repairs up to 32 stale rows before it runs.

## Storage

`MemoryCell` (one Durable Object per user) holds `memories`, the FTS5 mirror
`memories_fts` (kept in sync by triggers), `memory_suppressions`,
`embedding_cache`, and — with the local provider — the `memory_vectors` vec0
table. Everything replicates to the bucket with the rest of the cell, so a
single-node Kody has semantic search with zero extra services. The vec0 chunk
size is derived from the embedding dimension to stay under celld's SQLite value
cap; `sqlite_vec` is enabled in `wrangler.jsonc` `compatibility_flags`.

Qdrant mode uses REST (`PUT /collections/<name>`, `points/upsert`,
`points/search`, `points/scroll`, `points/delete`) with payload indexes on
`userId`, `status`, `category`; every query is filtered by `userId`, so one
collection safely serves many users.

## Admin endpoints

```sh
curl -s "$BASE/admin/ai" -H "authorization: Bearer $ADMIN"                       # parsed config, no key values
curl -s "$BASE/admin/users/$USER/memories?limit=50" -H "authorization: Bearer $ADMIN"
curl -s -X POST "$BASE/admin/users/$USER/memories/reindex" -H "authorization: Bearer $ADMIN"
```

Audit actions: `memory.create`, `memory.update`, `memory.delete.soft|hard`
(user), `memory.reindex` (admin) — ids, categories and counts only.

## Smoke coverage

`npm run smoke` runs the `memory` scenario in whatever mode the node is
configured for: capability discovery through `search`, `aiStatus` and
`GET /admin/ai` leaking no key, verify → upsert → get → search → delete,
conversation suppression, user isolation, admin listing/reindex and the audit
no-leak assertions. Extra modes:

```sh
# deterministic OpenAI-compatible mock (hashing-trick embeddings + echo chat)
npm run smoke:ai-mock &
KODY_AI_PROVIDER=openai KODY_AI_BASE_URL=http://127.0.0.1:8790/v1 \
KODY_AI_EMBED_DIMENSIONS=64 KODY_SEARCH_RERANK=llm npm run dev &
SMOKE_AI_MOCK=1 npm run smoke -- --only memory     # asserts hybrid + llm ranking

# same, with Qdrant
docker run -d -p 6333:6333 qdrant/qdrant:v1.15.4
KODY_VECTOR_PROVIDER=qdrant KODY_QDRANT_URL=http://127.0.0.1:6333 … npm run dev
```

The M3 PR also ran the scenario against a real Ollama `nomic-embed-text`
(768 dims) with the local sqlite-vec store: queries such as "automobile
commute" and "feline companion" ranked the car and cat memories first with no
lexical overlap.
