<div align="center">

# Cortex

**Local-first memory OS for AI coding agents**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-5A67D8)](https://modelcontextprotocol.io/)
[![SQLite](https://img.shields.io/badge/SQLite-sqlite--vec-003B57?logo=sqlite&logoColor=white)](https://github.com/asg017/sqlite-vec)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

---

## What It Does

Cortex is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that adds intelligent memory to [Claude Code](https://docs.anthropic.com/en/docs/claude-code). It reads from your existing [Engram](https://github.com/Gentleman-Programming/engram) database and layers on hybrid search, a knowledge graph, lifecycle management, and per-turn context briefs — all without touching your existing data or requiring a separate database.

You keep using Engram's `mem_save`, `mem_search`, and friends for writing observations. Cortex is the read-side intelligence layer: smarter retrieval, entity awareness, staleness detection, and automatic context injection.

---

## Why Cortex

| Capability | Plain Engram | **Cortex** | Mem0 | Zep | Letta |
|---|---|---|---|---|---|
| Full-text search (FTS5) | Yes | **Yes** | No | No | No |
| Vector similarity search | No | **Yes** | Yes | Yes | Yes |
| Hybrid FTS + vector with RRF fusion | No | **Yes** | Partial | Partial | No |
| Knowledge graph with entity extraction | No | **Yes** | No | Yes | Partial |
| Graph expansion (related memory traversal) | No | **Yes** | No | Partial | No |
| Lifecycle management (active/stale/deprecated) | No | **Yes** | No | No | No |
| Confidence scoring with age decay | No | **Yes** | No | No | No |
| Per-turn preflight context briefs | No | **Yes** | No | No | No |
| Local-first (SQLite, zero cloud) | Yes | **Yes** | No | No | No |
| MCP native (stdio, Claude Code plugin) | Yes | **Yes** | No | No | No |
| Minimal infrastructure (Engram + Ollama) | Yes | **Yes** | No | No | No |

**Key differentiators:**

- **Hybrid FTS5 + vector with RRF fusion** — most tools do one or the other. Cortex fuses both using Reciprocal Rank Fusion for significantly better recall on mixed queries.
- **Knowledge graph** — entity extraction runs on every observation (regex-based, no LLM calls). Entities connect across projects, enabling graph expansion during search.
- **Lifecycle-aware** — active, superseded, and deprecated states filter search results. Confidence scores decay over time (180-day half-life) and reset on verification.
- **MCP native** — runs as a stdio MCP server registered directly with Claude Code. The only network dependency is the engram-vec sidecar (port 7438) for vector search and embeddings.
- **Local-first** — SQLite + sqlite-vec + Ollama. Local-first and cloud-free. Minimal moving parts for users already running Engram + Ollama. Runs entirely on your machine.
- **Preflight briefs** — call `cortex_preflight` at the start of a turn to receive a compact, token-budgeted context brief of the most relevant decisions, gotchas, patterns, and todos for your current project.

---

## Architecture

```
Claude Code  <-->  MCP (stdio)  <-->  Cortex Server
                                          |
                                          +-- Search
                                          |     +-- FTS5 full-text search
                                          |     +-- Vector similarity (via engram-vec)
                                          |     +-- Reciprocal Rank Fusion (RRF)
                                          |     +-- Graph expansion
                                          |     +-- Lifecycle filtering
                                          |     +-- Recency + confidence scoring
                                          |
                                          +-- Knowledge Graph
                                          |     +-- Entity extraction (6 types)
                                          |     +-- Relation inference (uses/contains/implements)
                                          |     +-- BFS graph expansion (depth-limited CTE)
                                          |     +-- Backfill for existing observations
                                          |
                                          +-- Lifecycle
                                          |     +-- Status: active / superseded / deprecated
                                          |     +-- Confidence: age decay (180d half-life)
                                          |     +-- Verification boost (1.5x if verified < 7d)
                                          |     +-- Staleness warnings (>90d unverified)
                                          |
                                          +-- Preflight
                                          |     +-- Per-turn context briefs
                                          |     +-- Token-budgeted assembly (500 tokens)
                                          |     +-- Hash-based cache (5-min TTL)
                                          |     +-- Sorted by computed confidence
                                          |
                                          +-- Sync
                                          |     +-- 30s poller for new observations
                                          |     +-- Embedding backfill (rate-limited)
                                          |     +-- Entity extraction on new observations
                                          |
                                          +-- Status
                                                +-- DB health + observation counts
                                                +-- Embedding coverage
                                                +-- Ollama reachability
                                               |
                                   +-----------+-----------+
                                   |                       |
                            Engram SQLite DB          engram-vec sidecar
                            (~/.engram/engram.db)     (HTTP, port 7438)
                            + sqlite-vec extension         |
                                                      Ollama (port 11434)
                                                      nomic-embed-text 768d
```

Cortex opens the Engram SQLite database directly (read + Cortex-owned table writes). It never modifies Engram's core tables (`observations`, `observations_fts`, `sessions`). All Cortex data lives in separately-owned tables (`obs_lifecycle`, `entities`, `relations`, `obs_entities`, `preflight_cache`, `cortex_meta`).

---

## MCP Tools

| Tool | Description |
|---|---|
| `cortex_search` | Hybrid FTS5 + vector search with RRF fusion, lifecycle filtering, recency/confidence scoring, and automatic graph expansion for related observations |
| `cortex_status` | Health check — DB observation counts, embedding coverage percentage, engram-vec sidecar status, Ollama reachability |
| `cortex_verify` | Mark an observation as verified (resets the staleness clock; grants 1.5x confidence boost for 7 days) |
| `cortex_deprecate` | Deprecate an observation with a reason (excluded from all future searches) |
| `cortex_entities` | List extracted entities and their observation connections — browse what the knowledge graph knows |
| `cortex_relations` | Query typed relationships between entities (`uses`, `contains`, `implements`, `co-occurs`) |
| `cortex_preflight` | Per-turn context brief — top decisions, gotchas, architecture notes, todos, and patterns for a project, assembled within a token budget |

---

## How Search Works

Every `cortex_search` call runs a three-layer pipeline:

### Layer 1: FTS5 Full-Text Search

SQLite's FTS5 extension indexes every observation's title and content. Keyword queries run against this index, returning ranked results with BM25-style scoring. Fast, offline, no model required.

### Layer 2: Vector Similarity Search

Observations are embedded as 768-dimensional vectors using `nomic-embed-text` via Ollama. At query time, the query is embedded and compared against stored vectors using cosine similarity. The `engram-vec` sidecar manages embedding generation and the `observations_vec` virtual table.

### Layer 3: Graph Expansion

After direct search results are found, Cortex identifies which entities appear in those results, then traverses the knowledge graph (BFS, depth 2, up to 20 entities) to find related observations. These are appended with discounted scores (`0.5x` the lowest direct result score), surfacing observations that are topically connected but would not have matched the original query.

### Reciprocal Rank Fusion (RRF)

FTS5 and vector ranks are fused using RRF (`score = 1 / (60 + rank)`). Results from both sources are merged, deduplicated by observation ID (keeping the higher score), and sorted.

### Lifecycle Enrichment

Before results are returned:
- **Deprecated** and **superseded** observations are filtered out entirely.
- Remaining results receive a **composite score**: `search_score × lifecycle_confidence × recency_boost`.
- Lifecycle confidence decays from 1.0 with a 180-day half-life.
- Observations verified within 7 days receive a 1.5x boost; within 30 days, 1.2x.
- Observations unverified for more than 90 days receive a `[STALE Nd]` prefix in their title.

### Graceful Degradation

If the `engram-vec` sidecar is unavailable (Ollama down, not yet started), Cortex automatically falls back to FTS5-only search. The response is labeled `[FTS-only fallback]`. Graph expansion still runs in fallback mode.

---

## Prerequisites

- **Node.js 20+**
- **Ollama** running locally with the `nomic-embed-text` model pulled:
  ```bash
  ollama pull nomic-embed-text
  ```
- **engram-vec sidecar** running on port 7438 (provides the hybrid search HTTP API and manages vector embeddings)
- **Engram** with an existing database at `~/.engram/engram.db`
- **Claude Code CLI** — Cortex is designed to be registered as a Claude Code MCP plugin

---

## Installation

```bash
git clone https://github.com/milema-gif/cortex.git
cd cortex
npm install
npm run build
```

The compiled server will be at `dist/server.js`.

---

## Configuration

Copy the example MCP config:

```bash
cp .mcp.json.example .mcp.json
```

Edit `.mcp.json` and update the `cwd` path to your Cortex installation directory:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/path/to/cortex",
      "env": {
        "ENGRAM_DB": "$HOME/.engram/engram.db",
        "ENGRAM_VEC_URL": "http://127.0.0.1:7438",
        "OLLAMA_URL": "http://127.0.0.1:11434"
      }
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ENGRAM_DB` | `~/.engram/engram.db` | Path to your Engram SQLite database |
| `ENGRAM_VEC_URL` | `http://127.0.0.1:7438` | URL of the engram-vec sidecar (hybrid search + embeddings) |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | URL of your Ollama instance |
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `CORTEX_SYNC_INTERVAL_MS` | `30000` | How often to poll for new observations (milliseconds) |
| `CORTEX_BACKFILL_DELAY_MS` | `2500` | Delay between embedding requests during backfill (milliseconds) |
| `CORTEX_BACKFILL_MAX_PER_CYCLE` | `20` | Maximum observations to embed per backfill cycle |
| `CORTEX_MODE` | `default` | Runtime mode: `readonly`, `default`, `backfill-once`, `debug` |

---

## Runtime Modes

Cortex supports four runtime modes, selected via the `CORTEX_MODE` environment variable:

| Mode | Poller | Backfill | Explain Scoring | Use Case |
|------|--------|----------|-----------------|----------|
| `default` | Yes | Yes | On request | Normal operation |
| `readonly` | No | No | On request | Read-only consumption, no sync |
| `backfill-once` | No | Yes | On request | Run embedding backfill then stop sync |
| `debug` | Yes | Yes | Always on | Debugging search ranking |

### Examples

```bash
# Normal operation (default)
CORTEX_MODE=default node dist/server.js

# Read-only: no background sync, just serve searches
CORTEX_MODE=readonly node dist/server.js

# Backfill missing embeddings, then run without poller
CORTEX_MODE=backfill-once node dist/server.js

# Debug: every search result includes scoring breakdown
CORTEX_MODE=debug node dist/server.js
```

When `CORTEX_MODE` is unset, Cortex runs in `default` mode. Invalid values log a warning and fall back to `default`.

In `debug` mode, every `cortex_search` call automatically includes a scoring explanation showing: FTS score, vector score, graph expansion contribution, lifecycle confidence multiplier, recency boost, and final composite score. You can also request explain data in any mode by passing `explain: true` to `cortex_search`.

---

## Registering with Claude Code

Place or symlink your `.mcp.json` where Claude Code will find it. The standard location is the project root or `~/.claude/mcp.json` for global registration.

Example global registration in `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "node",
      "args": ["/path/to/cortex/dist/server.js"],
      "env": {
        "ENGRAM_DB": "/home/youruser/.engram/engram.db",
        "ENGRAM_VEC_URL": "http://127.0.0.1:7438",
        "OLLAMA_URL": "http://127.0.0.1:11434"
      }
    }
  }
}
```

Once registered, Claude Code will start Cortex automatically via stdio on each session. All seven `cortex_*` tools will be available.

---

## Project Structure

```
src/
├── server.ts              # Entry point — MCP server, tool registration, startup
├── config.ts              # Environment variable config with defaults
├── types.ts               # Shared TypeScript interfaces
│
├── core/
│   ├── search.ts          # Search coordinator — hybrid path, FTS fallback, graph expansion
│   ├── graph.ts           # Knowledge graph — entity upsert, relation inference, BFS expansion
│   ├── lifecycle.ts       # Lifecycle management — verify, deprecate, supersede, confidence
│   ├── preflight.ts       # Per-turn context brief generation with token budgeting
│   ├── status.ts          # Health check and stats collection
│   └── sync.ts            # Observation poller, embedding backfill, entity extraction
│
├── tools/
│   ├── search.ts          # MCP tool: cortex_search
│   ├── status.ts          # MCP tool: cortex_status
│   ├── lifecycle.ts       # MCP tools: cortex_verify, cortex_deprecate
│   ├── preflight.ts       # MCP tool: cortex_preflight
│   └── graph.ts           # MCP tools: cortex_entities, cortex_relations
│
├── db/
│   ├── connection.ts      # SQLite connection with sqlite-vec extension loading
│   ├── schema.ts          # Cortex-owned schema migrations (v1, v2)
│   └── retry.ts           # Retry logic for transient DB errors
│
├── lib/
│   ├── engram-vec.ts      # HTTP client for engram-vec sidecar (hybrid search + embed)
│   ├── entity-patterns.ts # Rules-based entity extraction (6 types, no LLM)
│   ├── token-budget.ts    # Token estimation and brief assembly within budget
│   └── logger.ts          # Structured stderr logger
│
└── tests/
    └── *.test.ts          # Unit tests (Node.js built-in test runner)
```

---

## How It Builds on Engram

Cortex and Engram have a clear division of responsibility:

**Engram** is the memory database. It provides the `observations` table, the FTS5 index (`observations_fts`), session management, and the write-side MCP tools (`mem_save`, `mem_search`, `mem_update`, etc.). Engram is where observations are created and stored.

**Cortex** is the intelligence layer on top. It opens the same SQLite file Engram uses and adds its own tables alongside Engram's:

| Table | Owner | Purpose |
|---|---|---|
| `observations` | Engram | Core observation storage |
| `observations_fts` | Engram | FTS5 full-text index |
| `observations_vec` | engram-vec | Vector embeddings |
| `obs_lifecycle` | **Cortex** | Status, confidence, verification timestamps |
| `entities` | **Cortex** | Extracted entities (project, tech, tool, pattern, file, person) |
| `relations` | **Cortex** | Typed entity relationships |
| `obs_entities` | **Cortex** | Observation-to-entity links |
| `preflight_cache` | **Cortex** | Cached preflight briefs with TTL |
| `cortex_meta` | **Cortex** | Schema version, sync bookmark |

Cortex never writes to Engram's tables. The schema migration explicitly avoids touching `observations`, `observations_fts`, or `sessions`. This means you can upgrade, swap, or remove Cortex without affecting your Engram data.

**The intended workflow:**

1. Use Engram (`mem_save`, `mem_update`) to write observations as normal.
2. Cortex's sync poller picks up new observations every 30 seconds, extracts entities, and triggers embedding via engram-vec.
3. Use `cortex_search` instead of `mem_search` for retrieval — you get hybrid search, graph expansion, and lifecycle filtering.
4. Call `cortex_preflight` at the start of a work session on a project for an automatic context brief.
5. Call `cortex_verify` on observations you've confirmed are still accurate to keep confidence scores healthy.

---

## Acknowledgements

- [Engram](https://github.com/Gentleman-Programming/engram) — the persistent memory foundation that Cortex builds on. Cortex is nothing without the observations Engram stores.
- [sqlite-vec](https://github.com/asg017/sqlite-vec) — the vector search extension for SQLite that makes local embedding search possible without a separate vector database.
- [nomic-embed-text](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) — the 768-dimensional embedding model used for semantic search. Runs locally via Ollama.
- [Ollama](https://ollama.ai) — local inference engine for running embedding models without cloud dependencies.
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) — the Model Context Protocol TypeScript SDK that powers the stdio server and tool registration.
- [Sentinel](https://github.com/milema-gif/sentinel) — behavioral guardrails for Claude Code, companion project.
- [Aegis](https://github.com/milema-gif/aegis) — pipeline guardrails for AI agents, companion project.
- Built for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) by Anthropic.

---

## License

MIT — see [LICENSE](LICENSE) for details.
