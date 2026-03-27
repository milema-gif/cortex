---
phase: 08-tests-release
plan: 01
subsystem: testing
tags: [node-test, fts5, composite-scoring, cache-invalidation, lifecycle]

# Dependency graph
requires:
  - phase: 02-preflight-lifecycle
    provides: lifecycle filtering, preflight cache with hash-based dedup
  - phase: 05-sync-correctness
    provides: sync_failures table, sync health reporting
provides:
  - 153 passing tests with zero failures
  - Ranking order tests proving composite score sorts correctly
  - Cache invalidation test proving preflight detects new observations
affects: [08-02-PLAN]

# Tech tracking
tech-stack:
  added: []
  patterns: [subprocess tests use dist/ for plain node compatibility]

key-files:
  created: []
  modified:
    - src/tests/config.test.ts
    - src/tests/status.test.ts
    - src/tests/logger.test.ts
    - src/tests/search.test.ts
    - src/tests/preflight.test.ts

key-decisions:
  - "Subprocess tests (config, logger) must use dist/ path since plain node cannot load .ts files when tsx runs the test runner"
  - "Status tests override config.engramVecUrl to unreachable endpoint to prevent false positives from running engram-vec service"

patterns-established:
  - "Subprocess test pattern: use path.resolve(process.cwd(), 'dist') for node subprocess imports"
  - "Service isolation pattern: override config URLs to unreachable endpoints when testing error/down paths"

requirements-completed: [TEST-01]

# Metrics
duration: 5min
completed: 2026-03-27
---

# Phase 8 Plan 1: Test Fixes and Coverage Gaps Summary

**Fixed 4 pre-existing test failures and added 4 new tests for composite score ranking order and cache invalidation -- 153 tests, all green**

## Performance

- **Duration:** 5 min
- **Started:** 2026-03-27T13:02:09Z
- **Completed:** 2026-03-27T13:06:49Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- Fixed 4 pre-existing test failures: config subprocess path, status engram-vec URL override, logger subprocess path (x2)
- Added 3 ranking order tests proving composite score sorts recent > old > stale correctly
- Added 1 cache invalidation test proving preflight detects new observations via hash change
- Full test suite: 153 tests, 0 failures, 0 cancelled

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix 4 pre-existing test failures** - `e041548` (fix)
2. **Task 2: Add ranking order and cache invalidation tests** - `972935d` (test)
3. **Task 2b: Add FTS rank dominance test** - `b628453` (test)

## Files Created/Modified
- `src/tests/config.test.ts` - Fixed subprocess to use dist/ path instead of src/
- `src/tests/status.test.ts` - Override engramVecUrl to force "down" status in tests
- `src/tests/logger.test.ts` - Fixed subprocess to use dist/ path instead of src/
- `src/tests/search.test.ts` - Added 3 composite score ranking order tests
- `src/tests/preflight.test.ts` - Added 1 cache invalidation test

## Decisions Made
- Subprocess tests (config.test.ts, logger.test.ts) were failing because tsx resolves import.meta.url to .ts source files, but the subprocess uses plain node which cannot import .ts files. Fix: use dist/ directory path.
- Status test was failing because engram-vec is actually running on this machine. Fix: override config.engramVecUrl to unreachable endpoint, same pattern used in search.test.ts.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All 153 tests pass green -- ready for 08-02 (release checklist)
- No blockers or concerns

---
*Phase: 08-tests-release*
*Completed: 2026-03-27*
