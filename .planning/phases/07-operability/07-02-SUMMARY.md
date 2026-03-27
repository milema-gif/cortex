---
phase: 07-operability
plan: 02
subsystem: infra
tags: [runtime-modes, env-config, operability]

requires:
  - phase: 07-01
    provides: "explain scoring infrastructure on cortex_search"
provides:
  - "CORTEX_MODE env var with four runtime modes (readonly, default, backfill-once, debug)"
  - "Mode-gated server startup (poller/backfill conditional on mode)"
  - "Debug mode auto-enables explain scoring on all searches"
affects: [08-release]

tech-stack:
  added: []
  patterns: ["env-var-driven runtime mode gating with validation and fallback"]

key-files:
  created: []
  modified:
    - src/config.ts
    - src/server.ts
    - src/tools/search.ts
    - README.md

key-decisions:
  - "CortexMode type union with parseCortexMode() validator in config.ts"
  - "Invalid CORTEX_MODE warns via stderr (logger not available in config module) and falls back to default"
  - "debug and default share same startup path (backfill + poller); debug differs only at search layer"

patterns-established:
  - "Runtime mode pattern: parse env in config.ts, switch/case in server.ts, feature flag in tool handlers"

requirements-completed: [OPER-02]

duration: 2min
completed: 2026-03-27
---

# Phase 7 Plan 2: Runtime Mode Controls Summary

**Four CORTEX_MODE runtime modes (readonly, default, backfill-once, debug) gating server startup and search behavior via env var**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-27T12:52:25Z
- **Completed:** 2026-03-27T12:54:29Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- CORTEX_MODE env var with type-safe parsing, validation, and fallback to default
- Server startup conditionally gates backfill and poller based on mode (readonly skips both, backfill-once skips poller)
- Debug mode auto-enables explain scoring on all cortex_search calls
- README documented with Runtime Modes section including table, examples, and env var entry

## Task Commits

Each task was committed atomically:

1. **Task 1: Add CORTEX_MODE to config and gate server startup** - `7e796dd` (feat)
2. **Task 2: Wire debug mode auto-explain and document in README** - `f776166` (feat)

## Files Created/Modified
- `src/config.ts` - CortexMode type, parseCortexMode() with validation, cortexMode in config object
- `src/server.ts` - switch/case on cortexMode gating backfill and poller startup
- `src/tools/search.ts` - Auto-enable explain when cortexMode is debug
- `README.md` - Runtime Modes section with table, examples; CORTEX_MODE in env vars table

## Decisions Made
- Invalid mode warning uses stderr directly since logger is not available at config parse time
- debug and default share the same startup path (both run backfill + poller); debug mode only differs at the search tool layer where explain is auto-enabled
- Used switch/case with explicit cases rather than if/else for clarity and extensibility

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing flaky test (status.test.js "reports engram-vec as down when unavailable") fails regardless of changes - confirmed by testing against pre-change code. 148/149 tests pass, same as before this plan.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All Phase 7 (Operability) plans complete
- Ready for Phase 8 (Release)
- Runtime modes provide operational flexibility for production, maintenance, debugging, and read-only scenarios

---
*Phase: 07-operability*
*Completed: 2026-03-27*
