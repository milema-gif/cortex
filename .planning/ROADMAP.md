# Roadmap: Cortex

## Milestones

- ✅ **v1.0 MVP** - Phases 1-4 (shipped 2026-03-25)
- ✅ **v0.2.0 Hardening & Honesty** - Phases 5-8 (completed 2026-03-27)
- 🚧 **Operational Proof** - Phase 9 (in progress)

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

<details>
<summary>v0.2.0 Hardening & Honesty (Phases 5-8) - COMPLETED 2026-03-27</summary>

### Phase 5: Sync Correctness
**Goal**: Embedding sync never silently loses work -- failures are detected, recorded, and surfaced
**Depends on**: Phase 4 (v1.0 sync module)
**Requirements**: SYNC-01, SYNC-02, SYNC-03
**Plans**: 2 plans

Plans:
- [x] 05-01-PLAN.md — Fix sync bookmark invariant, add sync_failures table with retry/park logic
- [x] 05-02-PLAN.md — Add sync_health section to cortex_status

### Phase 6: Honesty & Metadata
**Goal**: README and package metadata accurately describe what Cortex is and what it requires
**Depends on**: Nothing (independent of Phase 5)
**Requirements**: README-01, README-02, README-03, README-04, META-01
**Plans**: 1 plan

Plans:
- [x] 06-01-PLAN.md — Fix README honesty claims + license consistency (README, package.json, LICENSE)

### Phase 7: Operability
**Goal**: Users can understand why search returns what it does, and run Cortex in well-defined operational modes
**Depends on**: Phase 5 (debug mode needs sync status data for completeness)
**Requirements**: OPER-01, OPER-02
**Plans**: 2 plans

Plans:
- [x] 07-01-PLAN.md — Debug/explain scoring mode: instrument search pipeline with per-result scoring breakdown
- [x] 07-02-PLAN.md — Runtime mode controls: CORTEX_MODE env var with 4 modes, README documentation

### Phase 8: Tests & Release
**Goal**: All hardening work is proven by tests and shipped as a proper tagged release
**Depends on**: Phases 5, 6, 7
**Requirements**: TEST-01, REL-01
**Plans**: 2 plans

Plans:
- [x] 08-01-PLAN.md — Fix pre-existing test failures, add ranking order + cache invalidation tests
- [x] 08-02-PLAN.md — CHANGELOG.md, version bump to 0.2.0, git tag v0.2.0

</details>

### Operational Proof (In Progress)

**Milestone Goal:** Cross-stack operational proof. Cortex workstream: sync failures are impossible to ignore -- degraded health blocks mutating operations, reconciliation is explicit.

### Phase 9: Blocking Reconciliation
**Goal**: Sync failures are impossible to ignore -- degraded health blocks mutating operations, reconciliation is explicit
**Depends on**: Phase 5 (sync_failures table and retry/park logic)
**Requirements**: [RECON-01, RECON-02, RECON-03, RECON-04]
**Plans**: 2 plans

Plans:
- [ ] 09-01-PLAN.md — Health computation (healthy/degraded/blocked) + reconcile action handlers (retry/drop/ack)
- [ ] 09-02-PLAN.md — cortex_reconcile MCP tool, execution gate on sync/backfill, comprehensive tests

**Success Criteria** (what must be TRUE):
  1. cortex_status returns a health field: healthy (no failures), degraded (failures exist), blocked (parked >5 or any parked >24h)
  2. cortex_reconcile tool provides retry(id), drop(id), ack actions -- no silent auto-clearing
  3. When health=blocked, syncNewObservations and embeddingBackfill skip and log error; reads continue with degraded banner
  4. After cortex_reconcile ack, mutating operations resume for current session
  5. Tests cover all reconciliation paths: thresholds, retry, drop, ack, gate blocking

## Progress

**Execution Order:**
Phases 1-8 complete. Phase 9 in progress.

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. MCP Server + Search | v1.0 | 3/3 | Complete | 2026-03-25 |
| 2. Preflight + Lifecycle | v1.0 | 3/3 | Complete | 2026-03-25 |
| 3. Knowledge Graph | v1.0 | 3/3 | Complete | 2026-03-25 |
| 4. Integration Hardening | v1.0 | 2/2 | Complete | 2026-03-25 |
| 5. Sync Correctness | v0.2.0 | 2/2 | Complete | 2026-03-27 |
| 6. Honesty & Metadata | v0.2.0 | 1/1 | Complete | 2026-03-27 |
| 7. Operability | v0.2.0 | 2/2 | Complete | 2026-03-27 |
| 8. Tests & Release | v0.2.0 | 2/2 | Complete | 2026-03-27 |
| 9. Blocking Reconciliation | 2/2 | Complete   | 2026-03-27 | - |
