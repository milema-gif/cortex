/**
 * Retry wrapper for SQLITE_BUSY errors with exponential backoff.
 * Uses synchronous busy-wait since better-sqlite3 is a synchronous API.
 *
 * @param fn - The function to execute (typically a DB operation)
 * @param maxRetries - Maximum number of retries (default 3)
 * @returns The result of fn()
 * @throws The original error if non-BUSY, or BUSY after max retries exhausted
 */
export function withRetry<T>(fn: () => T, maxRetries = 3): T {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const error = err as { code?: string; message?: string };
      if (error.code === "SQLITE_BUSY" && attempt < maxRetries) {
        const delay = Math.min(100 * Math.pow(2, attempt), 2000);
        // Synchronous busy-wait (better-sqlite3 is synchronous)
        const end = Date.now() + delay;
        while (Date.now() < end) {
          /* busy wait */
        }
        continue;
      }
      throw err;
    }
  }
  // Unreachable, but TypeScript needs it
  throw new Error("withRetry: unreachable");
}
