# Changelog

## v0.2.0 — Hardening & Honesty (2026-03-27)

Addresses all findings from external Codex/GPT audit.

### Fixed
- **Sync correctness**: embedding sync no longer silently loses work — failed embeds are tracked in `sync_failures` table with retry (up to 5 attempts) and park logic
- **Backfill correctness**: `embeddingBackfill` now checks `response.ok` — non-200 responses no longer count as success
- **README honesty**: removed misleading "zero infrastructure" claims; engram-vec and Ollama dependencies now honestly documented
- **License alignment**: README, package.json, and LICENSE all consistently say MIT

### Added
- `sync_failures` table: tracks failed embeds with attempt count, error, timestamps, pending/parked status
- Sync health reporting in `cortex_status`: pending count, parked count, oldest failure, total retries
- Debug/explain scoring mode: opt-in `explain` parameter on `cortex_search` shows per-result FTS, vector, graph, lifecycle, and recency score breakdown
- Runtime mode control via `CORTEX_MODE` env var: `readonly`, `default`, `backfill-once`, `debug`
- Test coverage for ranking order, confidence decay, cache invalidation, sync failure/retry
- CHANGELOG.md

### Changed
- `filterLifecycle` returns `{kept, excluded}` object (backward-compatible)
- Version bump: 0.1.0 -> 0.2.0

## v0.1.0 — MVP (2026-03-25)

Initial release with MCP server, hybrid FTS5+vector search, preflight briefs, knowledge graph, and embedding sync.
