---
phase: 05-sync-correctness
plan: 01
subsystem: database, sync
tags: [sqlite, sync, retry, failure-tracking, bookmark-invariant]

# Dependency graph
requires:
  - phase: 01-mcp-server-search
    provides: "Core sync module (sync.ts) and schema migrations"
provides:
  - "sync_failures table for tracking embed failures"
  - "response.ok gating on all embed calls"
  - "Retry/park logic for failed embeds"
  - "SyncFailureRow type"
  - "syncMaxRetries config"
affects: [06-honesty, 07-operability, 08-test-release]

# Tech tracking
tech-stack:
  added: []
  patterns: [failure-tracking-table, retry-with-park, bookmark-invariant]

key-files:
  created: []
  modified:
    - src/core/sync.ts
    - src/db/schema.ts
    - src/types.ts
    - src/config.ts
    - src/core/status.ts
    - src/tests/sync.test.ts
    - src/tests/schema.test.ts

key-decisions:
  - "Bookmark advances past failed observations -- failures tracked in sync_failures, not blocking sync"
  - "Retry pending failures at start of each sync cycle before processing new observations"
  - "Park after 5 failed attempts (configurable via CORTEX_SYNC_MAX_RETRIES)"

patterns-established:
  - "Failure tracking pattern: sync_failures table with attempt_count, last_error, status (pending/parked)"
  - "Bookmark invariant: every observation_id <= bookmark is either embedded or in sync_failures"

requirements-completed: [SYNC-01, SYNC-02]

# Metrics
duration: 8min
completed: 2026-03-27
---

# Phase 5 Plan 1: Sync Correctness Summary

**Fixed critical sync bug: embed failures now detected via response.ok, tracked in sync_failures table, retried each cycle, and parked after 5 attempts**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-27T12:06:13Z
- **Completed:** 2026-03-27T12:14:25Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Fixed the #1 correctness bug from Codex audit: non-200 embed responses no longer silently lost
- Added sync_failures table (migration v3) with full retry/park lifecycle
- Comprehensive TDD test suite: 18 sync tests (10 new), all passing
- Bookmark invariant enforced: every observation <= bookmark is either embedded or tracked

## Task Commits

Each task was committed atomically:

1. **Task 1: Add sync_failures schema, type, config, and status table registration** - `a3fc043` (feat)
2. **Task 2 RED: Add failing tests for failure tracking/retry/park** - `f738437` (test)
3. **Task 2 GREEN: Fix sync bookmark invariant with failure tracking** - `b0a8a95` (feat)
4. **Task 2 deviation: Update schema tests for v3 migration** - `e4dba76` (fix)

## Files Created/Modified
- `src/core/sync.ts` - Fixed syncNewObservations and embeddingBackfill with response.ok check, failure recording, retry/park logic
- `src/db/schema.ts` - Added migration v3 creating sync_failures table with status CHECK constraint
- `src/types.ts` - Added SyncFailureRow interface
- `src/config.ts` - Added syncMaxRetries config (default 5, env-configurable)
- `src/core/status.ts` - Added sync_failures to CORTEX_TABLES for status reporting
- `src/tests/sync.test.ts` - 10 new tests for failure tracking, retry, park, crash recovery, bookmark invariant
- `src/tests/schema.test.ts` - Updated for v3 migration (table count 6->7, version '2'->'3')

## Decisions Made
- Bookmark advances past failed observations: failures are tracked in sync_failures table rather than blocking all subsequent sync. A permanently-failing observation would halt all sync if bookmark didn't advance.
- Retry phase runs before new observation processing each cycle, ensuring pending failures get retried promptly.
- Park threshold of 5 attempts (configurable) prevents infinite retry loops while giving transient failures a fair chance.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated schema.test.ts for v3 migration**
- **Found during:** Task 2 (overall verification)
- **Issue:** Existing schema test expected version '2' and 6 tables; v3 migration added sync_failures (7 tables, version '3')
- **Fix:** Updated table count assertion (6->7, added sync_failures) and version assertion ('2'->'3')
- **Files modified:** src/tests/schema.test.ts
- **Verification:** Schema tests pass
- **Committed in:** e4dba76

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary update to existing tests to reflect v3 migration. No scope creep.

## Issues Encountered
- Pre-existing status test failure ("reports engram-vec as down when unavailable") -- fails because engram-vec is actually running on this machine. Not related to our changes, not addressed.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- sync_failures table and retry/park logic complete
- Ready for Phase 5 Plan 2 (if exists) or Phase 6 (Honesty)
- Note: existing observations that silently failed embedding before this fix may need re-processing via embeddingBackfill

## Self-Check: PASSED

All 8 files verified present. All 4 commit hashes verified in git log.

---
*Phase: 05-sync-correctness*
*Completed: 2026-03-27*
