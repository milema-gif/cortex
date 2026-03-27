import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Use dist/ directory for subprocess (plain node can't load .ts files via tsx)
const distDir = path.resolve(process.cwd(), "dist");

describe("logger", () => {
  it("log() writes to stderr, not stdout", () => {
    const proc = spawnSync("node", ["--input-type=module", "-e", `
      import { log } from "${distDir}/lib/logger.js";
      log("info", "test message");
    `], { encoding: "utf-8" });

    // stdout should be empty
    assert.equal(proc.stdout.trim(), "", "stdout must be empty — log() should only write to stderr");
    // stderr should have content
    assert.ok(proc.stderr.length > 0, "stderr should have output from log()");
  });

  it("log() stderr output includes timestamp and level prefix", () => {
    const proc = spawnSync("node", ["--input-type=module", "-e", `
      import { log } from "${distDir}/lib/logger.js";
      log("error", "something broke");
    `], { encoding: "utf-8" });

    const stderr = proc.stderr;
    assert.ok(stderr.includes("[cortex"), "stderr should include [cortex prefix");
    assert.ok(stderr.includes("ERROR:"), "stderr should include level prefix");
    assert.ok(stderr.includes("something broke"), "stderr should include the message");
    // Check timestamp pattern HH:MM:SS.mmm
    assert.ok(/\d{2}:\d{2}:\d{2}\.\d{3}/.test(stderr), "stderr should include timestamp HH:MM:SS.mmm");
  });

  it("log() with info level shows INFO prefix", () => {
    const proc = spawnSync("node", ["--input-type=module", "-e", `
      import { log } from "${distDir}/lib/logger.js";
      log("info", "startup complete");
    `], { encoding: "utf-8" });

    assert.ok(proc.stderr.includes("INFO:"), "stderr should include INFO: prefix");
    assert.ok(proc.stderr.includes("startup complete"), "stderr should include the message");
  });
});
