import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withRetry } from "../db/retry.js";

describe("retry", () => {
  it("withRetry() returns result on first success", () => {
    const result = withRetry(() => 42);
    assert.equal(result, 42);
  });

  it("withRetry() retries SQLITE_BUSY errors up to 3 times", () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts++;
      if (attempts < 3) {
        const err: any = new Error("database is locked");
        err.code = "SQLITE_BUSY";
        throw err;
      }
      return "success";
    });
    assert.equal(result, "success");
    assert.equal(attempts, 3);
  });

  it("withRetry() throws non-BUSY errors immediately", () => {
    let attempts = 0;
    assert.throws(
      () => {
        withRetry(() => {
          attempts++;
          throw new Error("some other error");
        });
      },
      /some other error/
    );
    assert.equal(attempts, 1, "Should not retry non-BUSY errors");
  });

  it("withRetry() throws after max retries exhausted", () => {
    let attempts = 0;
    assert.throws(
      () => {
        withRetry(() => {
          attempts++;
          const err: any = new Error("database is locked");
          err.code = "SQLITE_BUSY";
          throw err;
        }, 3);
      },
      /database is locked/
    );
    assert.equal(attempts, 4, "Should attempt 1 + 3 retries = 4 total");
  });

  it("withRetry() uses exponential backoff (timing check)", () => {
    let attempts = 0;
    const timestamps: number[] = [];

    assert.throws(() => {
      withRetry(() => {
        timestamps.push(Date.now());
        attempts++;
        const err: any = new Error("database is locked");
        err.code = "SQLITE_BUSY";
        throw err;
      }, 2);
    });

    // With maxRetries=2, we get 3 attempts (1 initial + 2 retries)
    assert.equal(timestamps.length, 3);

    // First delay: ~100ms (100 * 2^0)
    const delay1 = timestamps[1] - timestamps[0];
    assert.ok(delay1 >= 80, `First delay should be ~100ms, got ${delay1}ms`);

    // Second delay: ~200ms (100 * 2^1)
    const delay2 = timestamps[2] - timestamps[1];
    assert.ok(delay2 >= 160, `Second delay should be ~200ms, got ${delay2}ms`);
    assert.ok(delay2 > delay1 * 1.3, `Second delay (${delay2}ms) should be greater than first (${delay1}ms)`);
  });
});
