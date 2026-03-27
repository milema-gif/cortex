# Requirements: Cortex

**Defined:** 2026-03-25
**Core Value:** AI coding agents recall the right memory at the right time, even when query wording differs from stored text.

## v1 Requirements (Complete)

All 34 v1 requirements satisfied. See v1.0-MILESTONE-AUDIT.md for details.

<details>
<summary>v1 Requirements (34/34 complete)</summary>

### MCP Foundation

- [x] **MCP-01**: MCP server starts via stdio transport and registers all tools with Claude Code
- [x] **MCP-02**: DB schema migration creates all Cortex tables (obs_lifecycle, entities, relations, obs_entities, preflight_cache) on first run
- [x] **MCP-03**: All logging goes to stderr; zero stdout outside JSON-RPC protocol messages
- [x] **MCP-04**: SQLite BUSY errors retry with exponential backoff (up to 3 retries, busy_timeout=5000ms)
- [x] **MCP-05**: Global error handler catches unhandled exceptions without crashing the server
- [x] **MCP-06**: WAL mode verified on startup; server refuses to start if WAL is not enabled
- [x] **MCP-07**: Health/status tool reports: DB connectivity, engram-vec availability, Ollama status, table row counts

### Search Coordination

- [x] **SRCH-01**: User can search memories via `cortex_search` with hybrid FTS5+vector results from engram-vec
- [x] **SRCH-02**: Search results are filtered by project when project context is provided
- [x] **SRCH-03**: Search results exclude deprecated and superseded observations (lifecycle-aware)
- [x] **SRCH-04**: Search results are ranked by composite score: relevance + recency + confidence
- [x] **SRCH-05**: Search results include graph-expanded matches (entities connected to query matches, BFS depth=2, max 20 entities)

### Preflight Memory Brief

- [x] **PRE-01**: `cortex_preflight` returns a compact memory brief for the current project context
- [x] **PRE-02**: Preflight brief includes: recent decisions, known gotchas, active architecture patterns, and relevant todos
- [x] **PRE-03**: Preflight brief is capped at 500 tokens maximum (hard budget, configurable)
- [x] **PRE-04**: Consecutive identical briefs are deduplicated (return "no change" if brief matches previous)
- [x] **PRE-05**: Preflight gracefully degrades: returns FTS-only results if engram-vec is down, returns empty brief if DB is unavailable

### Observation Lifecycle

- [x] **LIFE-01**: Each observation can be marked as active, superseded, or deprecated via `cortex_deprecate` tool
- [x] **LIFE-02**: Superseding an observation creates a link: new observation references the one it replaces
- [x] **LIFE-03**: `cortex_verify` marks an observation as recently verified (updates last_verified_at)
- [x] **LIFE-04**: Observations have confidence scores derived from: age, verification recency, superseded status
- [x] **LIFE-05**: Duplicate/contradiction detection flags potential conflicts when saving observations with similar content to existing active observations
- [x] **LIFE-06**: Stale observations (unverified > 90 days) are flagged with warnings in search and preflight results
- [x] **LIFE-07**: Lifecycle operations are idempotent (deprecating an already-deprecated observation is a no-op)

### Knowledge Graph

- [x] **GRPH-01**: Entity/relation/obs_entities tables store extracted knowledge graph data in SQLite
- [x] **GRPH-02**: Rules-based entity extraction runs automatically on new observations (project names, file paths, tool names, tech terms, decision patterns)
- [x] **GRPH-03**: Entity names are normalized on insert (lowercase, strip punctuation) with an aliases table for alternate forms
- [x] **GRPH-04**: Graph expansion on query retrieves memories connected via entity relationships (recursive CTE, depth=2, max 20 entities)
- [x] **GRPH-05**: `cortex_entities` tool lists entities with their observation counts and types
- [x] **GRPH-06**: `cortex_relations` tool shows relationships for a given entity
- [x] **GRPH-07**: Entity extraction covers 80%+ of coding-domain entities in existing observation corpus

### Integration

- [x] **INTG-01**: Cortex coexists with Engram Go binary — only writes to Cortex-owned tables, never modifies Engram tables
- [x] **INTG-02**: Cortex detects new observations from Engram via polling (MAX(id) check) and triggers entity extraction + embedding sync
- [x] **INTG-03**: Rate-limited embedding backfill completes remaining ~537 observations (2.5s sleep between calls, max 20/cycle)

</details>

## v0.2.0 Requirements (Hardening & Honesty)

Requirements from external Codex/GPT audit. All address concrete findings.

### Sync Correctness

- [x] **SYNC-01**: sync.ts checks response.ok before advancing bookmark -- failed embeds do NOT count as synced. Bookmark only advances on confirmed 2xx response.
- [x] **SYNC-02**: Cortex maintains a sync_failures table (observation_id, attempt_count, last_error, last_attempt_at, status) for every failed embed. Failed observations are retried on subsequent sync cycles up to a configurable max (default 5), then parked with status='parked'.
- [x] **SYNC-03**: `cortex_status` output includes sync health: count of pending failures, count of parked failures, oldest pending failure age, last successful sync timestamp.

### README Honesty

- [x] **README-01**: README infrastructure section rewritten to: "Local-first and cloud-free. Minimal moving parts for users already running Engram + Ollama." Explicitly lists engram-vec sidecar (port 7438) and Ollama (port 11434) as dependencies.
- [x] **README-02**: Remove or correct "no web server, no port, no daemon required" -- acknowledge engram-vec runs as an HTTP sidecar on port 7438.
- [x] **README-03**: Remove all "v0.3.0-hardened" references. Version in README matches package.json version.
- [x] **README-04**: Any mention of cortex_think, cortex_save, or cortex_graph_query is clearly marked as "Planned" or "Future" -- not presented as available tools.

### Metadata

- [x] **META-01**: package.json license field changed from "ISC" to "MIT". README license section says MIT. Both are consistent.

### Operability

- [x] **OPER-01**: Debug/explain mode for search scoring. When enabled, each search result includes: fts_score, vector_score, graph_expansion_contribution, lifecycle_confidence_multiplier, recency_boost, final_composite_score, and exclusion_reasons (for results that were filtered out).
- [x] **OPER-02**: Four documented runtime modes selectable via CORTEX_MODE env var: `readonly` (no poller, no backfill), `default` (poller enabled), `backfill-once` (run embedding backfill then disable poller), `debug` (attach scoring explain to all search results). Modes documented in README.

### Testing

- [x] **TEST-01**: Tests exist and pass for: (a) composite ranking produces correct order given known scores, (b) confidence decays with observation age and boosts with recent verification, (c) preflight cache is invalidated when new observations arrive, (d) sync detects embed failure (non-200) and records it in sync_failures, (e) sync retries previously-failed observations and advances bookmark on success.

### Release

- [x] **REL-01**: v0.2.0 tagged in git. CHANGELOG.md created with: summary of all audit fixes, list of new runtime modes, list of new cortex_status fields, breaking changes (if any), compatibility notes (requires engram-vec sidecar).

## v2 Requirements

Deferred to future milestone. Tracked but not in current roadmap.

### Auto-Consolidation (Layer 5)

- **CONS-01**: Daily clustering of related new observations into canonical project facts
- **CONS-02**: Weekly per-project summary of changed/superseded/still-true facts
- **CONS-03**: Spaced reinforcement re-surfaces high-value facts periodically

### Recall Telemetry (Layer 6)

- **TELE-01**: Track retrieval events: retrieved, used, contradicted, ignored
- **TELE-02**: Track stale hit rate and "miss then found later" rate
- **TELE-03**: On user correction, auto-create alias terms and update retrieval templates

### Enhanced Features

- **ENH-01**: Edit-blocking preflight signal (ready: true/false based on confidence)
- **ENH-02**: LLM-based entity extraction as optional enrichment pass
- **ENH-03**: Preflight caching with short TTL for repeated queries

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cloud sync / remote storage | Violates zero-cost, local-only constraints |
| Web dashboard / visualization UI | Consumer is MCP clients, not humans. CLI tools for debugging |
| Multi-user / multi-tenant | Single developer, single machine |
| Agent runtime / framework | Cortex is a memory layer, not an agent runtime |
| Automatic conversation extraction | Keep Engram's explicit save model. Agent decides what matters |
| Embedding model management | Ollama's job, not Cortex's |
| Modifying Engram Go binary | Source of truth for observation writes, don't touch |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

### v1.0 (Complete)

| Requirement | Phase | Status |
|-------------|-------|--------|
| MCP-01 | Phase 1 | Complete |
| MCP-02 | Phase 1 | Complete |
| MCP-03 | Phase 1 | Complete |
| MCP-04 | Phase 1 | Complete |
| MCP-05 | Phase 1 | Complete |
| MCP-06 | Phase 1 | Complete |
| MCP-07 | Phase 1 | Complete |
| SRCH-01 | Phase 1 | Complete |
| SRCH-02 | Phase 1 | Complete |
| SRCH-03 | Phase 2 | Complete |
| SRCH-04 | Phase 2 | Complete |
| SRCH-05 | Phase 3 | Complete |
| PRE-01 | Phase 2 | Complete |
| PRE-02 | Phase 2 | Complete |
| PRE-03 | Phase 2 | Complete |
| PRE-04 | Phase 2 | Complete |
| PRE-05 | Phase 2 | Complete |
| LIFE-01 | Phase 2 | Complete |
| LIFE-02 | Phase 2 | Complete |
| LIFE-03 | Phase 2 | Complete |
| LIFE-04 | Phase 2 | Complete |
| LIFE-05 | Phase 2 | Complete |
| LIFE-06 | Phase 2 | Complete |
| LIFE-07 | Phase 2 | Complete |
| GRPH-01 | Phase 3 | Complete |
| GRPH-02 | Phase 3 | Complete |
| GRPH-03 | Phase 3 | Complete |
| GRPH-04 | Phase 3 | Complete |
| GRPH-05 | Phase 3 | Complete |
| GRPH-06 | Phase 3 | Complete |
| GRPH-07 | Phase 3 | Complete |
| INTG-01 | Phase 1 | Complete |
| INTG-02 | Phase 4 | Complete |
| INTG-03 | Phase 4 | Complete |

### v0.2.0 (In Progress)

| Requirement | Phase | Status |
|-------------|-------|--------|
| SYNC-01 | Phase 5 | Complete |
| SYNC-02 | Phase 5 | Complete |
| SYNC-03 | Phase 5 | Complete |
| README-01 | Phase 6 | Complete |
| README-02 | Phase 6 | Complete |
| README-03 | Phase 6 | Complete |
| README-04 | Phase 6 | Complete |
| META-01 | Phase 6 | Complete |
| OPER-01 | Phase 7 | Complete |
| OPER-02 | Phase 7 | Complete |
| TEST-01 | Phase 8 | Complete |
| REL-01 | Phase 8 | Complete |

**Coverage:**
- v1.0 requirements: 34 total, 34 complete
- v0.2.0 requirements: 12 total, 2 complete
- Mapped to phases: 12/12
- Unmapped: 0

---
*Requirements defined: 2026-03-25*
*v0.2.0 requirements added: 2026-03-27 (from Codex/GPT audit)*
