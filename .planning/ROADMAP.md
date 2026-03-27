# Roadmap: Cortex

## Milestones

- ✅ **v1.0 MVP** - Phases 1-4 (shipped 2026-03-25)
- 🚧 **v0.2.0 Hardening & Honesty** - Phases 5-8 (in progress)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-4) - SHIPPED 2026-03-25</summary>

### Phase 1: MCP Server + Search
**Goal**: Agents can connect to Cortex via MCP and search memories with hybrid FTS5+vector results
**Plans**: 3 plans

Plans:
- [x] 01-01-PLAN.md — Project scaffold, DB foundation, engram-vec client
- [x] 01-02-PLAN.md — MCP server with cortex_search and cortex_status tools
- [x] 01-03-PLAN.md — End-to-end validation, Claude Code integration

### Phase 2: Preflight + Lifecycle
**Goal**: Every agent turn is informed by a trustworthy memory brief, with stale/superseded observations filtered out
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md — Lifecycle core: deprecation, supersession, verification, confidence scoring
- [x] 02-02-PLAN.md — Lifecycle-aware search + preflight engine with token budgeting
- [x] 02-03-PLAN.md — Server wiring, build validation, integration verify

### Phase 3: Knowledge Graph
**Goal**: Cortex extracts entities and relationships from observations, enabling lateral recall via graph connections
**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md — Entity extraction engine, normalization, relation inference
- [x] 03-02-PLAN.md — MCP graph tools + graph-expanded search integration
- [x] 03-03-PLAN.md — Server wiring, async backfill, integration verify

### Phase 4: Integration Hardening
**Goal**: Cortex stays in sync with Engram automatically and completes the full embedding backfill
**Plans**: 2 plans

Plans:
- [x] 04-01-PLAN.md — Sync module: observation polling, rate-limited backfill
- [x] 04-02-PLAN.md — Server wiring, build validation, integration verify

</details>

### v0.2.0 Hardening & Honesty (In Progress)

**Milestone Goal:** Address all findings from external Codex/GPT audit. Fix the critical sync correctness bug, make README claims honest, add operational observability, and prove it all with tests.

**Phase Numbering:**
- Integer phases (5, 6, 7, 8): Planned milestone work
- Decimal phases (5.1, 5.2): Urgent insertions (marked with INSERTED)

- [x] **Phase 5: Sync Correctness** - Fix silent embed failure bug, add sync status tracking, expose failure state (completed 2026-03-27)
- [x] **Phase 6: Honesty & Metadata** - Correct all misleading README claims, fix license mismatch, remove phantom version/feature references (completed 2026-03-27)
- [x] **Phase 7: Operability** - Debug/explain mode for search scoring, documented runtime modes (completed 2026-03-27)
- [x] **Phase 8: Tests & Release** - Tests for ranking/decay/cache/sync-recovery, proper v0.2.0 release (completed 2026-03-27)

## Phase Details

### Phase 5: Sync Correctness
**Goal**: Embedding sync never silently loses work -- failures are detected, recorded, and surfaced
**Depends on**: Phase 4 (v1.0 sync module)
**Requirements**: SYNC-01, SYNC-02, SYNC-03
**Plans**: 2 plans

Plans:
- [x] 05-01-PLAN.md — Fix sync bookmark invariant, add sync_failures table with retry/park logic
- [ ] 05-02-PLAN.md — Add sync_health section to cortex_status

**Success Criteria** (what must be TRUE):
  1. When engram-vec returns a non-200 response for /embed, the observation is tracked in sync_failures (not silently lost)
  2. Cortex maintains a sync_failures table showing: observation ID, attempt count, last error, last attempt timestamp for every failed embed
  3. `cortex_status` output includes a sync health section: pending failure count, parked count, oldest failure, total retry attempts
  4. Previously-failed embeds are retried on subsequent sync cycles (up to a configurable max before being parked)

### Phase 6: Honesty & Metadata
**Goal**: README and package metadata accurately describe what Cortex is and what it requires
**Depends on**: Nothing (independent of Phase 5)
**Requirements**: README-01, README-02, README-03, README-04, META-01
**Plans**: 1 plan

Plans:
- [ ] 06-01-PLAN.md — Fix README honesty claims + license consistency (README, package.json, LICENSE)

**Success Criteria** (what must be TRUE):
  1. README states that Cortex depends on engram-vec sidecar (port 7438) and Ollama (port 11434) -- no "zero infrastructure" claims remain
  2. README does not claim "no web server, no port, no daemon" -- the engram-vec dependency is honestly described
  3. No references to "v0.3.0-hardened" or any version other than the actual current version exist anywhere in the repo
  4. Proposed/future features (cortex_think, cortex_save, cortex_graph_query) are clearly marked as planned, not presented as current capabilities
  5. README and package.json both say MIT license

### Phase 7: Operability
**Goal**: Users can understand why search returns what it does, and run Cortex in well-defined operational modes
**Depends on**: Phase 5 (debug mode needs sync status data for completeness)
**Requirements**: OPER-01, OPER-02
**Plans**: 2 plans

Plans:
- [ ] 07-01-PLAN.md — Debug/explain scoring mode: instrument search pipeline with per-result scoring breakdown
- [ ] 07-02-PLAN.md — Runtime mode controls: CORTEX_MODE env var with 4 modes, README documentation

**Success Criteria** (what must be TRUE):
  1. When debug/explain mode is enabled, search results include a scoring breakdown: FTS contribution, vector contribution, graph expansion contribution, lifecycle/confidence adjustment, final composite score, and exclusion reasons for filtered results
  2. Cortex supports four documented runtime modes: read-only (no poller), poller-enabled (default), backfill-once (run backfill then exit poller), debug-scoring (attach explain data to all results)
  3. Runtime mode is selectable via environment variable (CORTEX_MODE), documented in README

### Phase 8: Tests & Release
**Goal**: All hardening work is proven by tests and shipped as a proper tagged release
**Depends on**: Phases 5, 6, 7
**Requirements**: TEST-01, REL-01
**Success Criteria** (what must be TRUE):
  1. Tests exist and pass for: composite ranking order (higher relevance + recency beats lower), confidence decay over time, preflight cache invalidation on new observations, sync failure detection and retry recovery
  2. All existing tests (132+) continue to pass
  3. v0.2.0 git tag exists with a CHANGELOG.md entry covering all audit fixes and compatibility notes
**Plans**: 2 plans

Plans:
- [ ] 08-01-PLAN.md — Fix pre-existing test failures, add ranking order + cache invalidation tests
- [ ] 08-02-PLAN.md — CHANGELOG.md, version bump to 0.2.0, git tag v0.2.0

## Progress

**Execution Order:**
Phases execute in numeric order: 5 -> 6 -> 7 -> 8
(Phase 6 can run in parallel with Phase 5 -- no code dependency)

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. MCP Server + Search | v1.0 | 3/3 | Complete | 2026-03-25 |
| 2. Preflight + Lifecycle | v1.0 | 3/3 | Complete | 2026-03-25 |
| 3. Knowledge Graph | v1.0 | 3/3 | Complete | 2026-03-25 |
| 4. Integration Hardening | v1.0 | 2/2 | Complete | 2026-03-25 |
| 5. Sync Correctness | v0.2.0 | 2/2 | Complete | 2026-03-27 |
| 6. Honesty & Metadata | v0.2.0 | 1/1 | Complete | 2026-03-27 |
| 7. Operability | v0.2.0 | 2/2 | Complete | 2026-03-27 |
| 8. Tests & Release | 2/2 | Complete   | 2026-03-27 | - |
