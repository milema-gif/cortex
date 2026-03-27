---
phase: 07-operability
plan: 01
subsystem: search
tags: [scoring, explain, debug, mcp, search-pipeline]

# Dependency graph
requires:
  - phase: 03-knowledge-graph
    provides: graph expansion pipeline (graphExpandResults)
  - phase: 02-preflight-lifecycle
    provides: lifecycle filtering and confidence scoring
provides:
  - ScoringExplanation, ExcludedCandidate, SearchExplainResult types
  - Instrumented search pipeline with opt-in explain mode
  - cortex_search explain parameter for per-result scoring breakdown
affects: [07-operability, 08-tests-release]

# Tech tracking
tech-stack:
  added: []
  patterns: [opt-in instrumentation with zero default overhead]

key-files:
  created: []
  modified:
    - src/types.ts
    - src/core/search.ts
    - src/tools/search.ts

key-decisions:
  - "filterLifecycle returns {kept, excluded} object instead of plain array -- backward-compatible since callers destructure"
  - "FTS fallback path returns empty excluded array (lifecycle filtering is in SQL, no excluded candidates available)"
  - "graph-expanded results get synthetic explain data with rrf_combined=0 and graph_expansion=graphScore"

patterns-established:
  - "Opt-in instrumentation: explain flag threads through pipeline, each stage conditionally captures intermediate scores"
  - "Zero-overhead default: when explain=false, no extra objects created, no extra queries"

requirements-completed: [OPER-01]

# Metrics
duration: 3min
completed: 2026-03-27
---

# Phase 7 Plan 1: Debug/Explain Scoring Mode Summary

**Opt-in explain mode on cortex_search showing per-result FTS, vector, graph, lifecycle, and recency score breakdown with excluded candidate tracking**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-27T12:46:23Z
- **Completed:** 2026-03-27T12:49:17Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Search pipeline instrumented with per-stage scoring capture (FTS, vector, RRF, lifecycle confidence, recency boost, graph expansion)
- Excluded candidates (deprecated/superseded) tracked with reasons and original scores
- Pipeline metadata captures candidate counts at each stage (total, post-filter, post-expansion)
- Zero overhead on default path -- explain only activates when explicitly requested

## Task Commits

Each task was committed atomically:

1. **Task 1: Add scoring explanation types and instrument search pipeline** - `9459dbd` (feat)
2. **Task 2: Wire explain parameter to cortex_search MCP tool** - `c47afaf` (feat)

## Files Created/Modified
- `src/types.ts` - Added ScoringExplanation, ExcludedCandidate, SearchExplainResult interfaces
- `src/core/search.ts` - Instrumented filterLifecycle, enrichWithLifecycle, graphExpandResults, and search() with explain support
- `src/tools/search.ts` - Added explain boolean parameter to cortex_search tool schema

## Decisions Made
- filterLifecycle now always returns `{kept, excluded}` object internally, keeping the API clean
- FTS fallback path returns empty excluded array since lifecycle filtering is embedded in the SQL query
- Graph-expanded results receive synthetic explain data (rrf_combined=0, graph_expansion=graphScore) since they don't go through RRF fusion

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing test failure in status.test.js (engram-vec availability check) -- unrelated to search explain changes, not addressed

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Explain mode ready for use via cortex_search tool
- Can be tested with any MCP client by passing explain=true
- Ready for Phase 7 Plan 2 (if applicable) or Phase 8

## Self-Check: PASSED

- All 3 modified files exist on disk
- Commit 9459dbd (Task 1) verified in git log
- Commit c47afaf (Task 2) verified in git log
- Build succeeds with no type errors
- 148/149 tests pass (1 pre-existing failure unrelated to this plan)

---
*Phase: 07-operability*
*Completed: 2026-03-27*
