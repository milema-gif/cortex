import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("config", () => {
  it("config.engramDb defaults to ~/.engram/engram.db", async () => {
    const { config } = await import("../config.js");
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp/test-home";
    assert.equal(config.engramDb, `${home}/.engram/engram.db`);
  });

  it("config.engramVecUrl defaults to http://127.0.0.1:7438", async () => {
    const { config } = await import("../config.js");
    assert.equal(config.engramVecUrl, "http://127.0.0.1:7438");
  });

  it("config.ollamaUrl defaults to http://127.0.0.1:11434", async () => {
    const { config } = await import("../config.js");
    assert.equal(config.ollamaUrl, "http://127.0.0.1:11434");
  });

  it("config reads from environment variables when set", async () => {
    const { spawnSync } = await import("node:child_process");
    const path = await import("node:path");
    // Use dist/ directory for subprocess (plain node can't load .ts files)
    const distDir = path.resolve(process.cwd(), "dist");

    const proc = spawnSync("node", ["--input-type=module", "-e", `
      const { config } = await import("file://${distDir}/config.js");
      console.log(JSON.stringify(config));
    `], {
      encoding: "utf-8",
      env: {
        ...process.env,
        ENGRAM_DB: "/tmp/test.db",
        ENGRAM_VEC_URL: "http://localhost:9999",
        OLLAMA_URL: "http://localhost:8888",
        LOG_LEVEL: "debug",
      },
    });

    const cfg = JSON.parse(proc.stdout.trim());
    assert.equal(cfg.engramDb, "/tmp/test.db");
    assert.equal(cfg.engramVecUrl, "http://localhost:9999");
    assert.equal(cfg.ollamaUrl, "http://localhost:8888");
    assert.equal(cfg.logLevel, "debug");
  });
});
