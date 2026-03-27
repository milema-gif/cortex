/**
 * Entity extraction patterns and normalization for knowledge graph.
 * Rules-based (regex + dictionary) extraction for 6 entity types.
 * No LLM calls -- purely deterministic.
 */

export type EntityType =
  | "project"
  | "file_path"
  | "technology"
  | "tool"
  | "pattern"
  | "person";

export interface ExtractedEntity {
  type: EntityType;
  rawName: string;
  normalizedName: string;
  aliases: string[];
}

// ─── Known Dictionaries ─────────────────────────────────────────────

// Customize: add your own project names for better entity extraction.
// These are used for Pass 1 of entity extraction — any project name listed
// here will be recognized and tagged as a "project" entity in observations.
const KNOWN_PROJECTS = new Set([
  "webapp",
  "api-server",
  "mobile-app",
  "cli-tool",
  "infrastructure",
  "cortex",
  "engram-vec",
]);

/** Technology terms dictionary (~50 terms, lowercase). */
const TECH_TERMS = new Set([
  "sqlite",
  "fts5",
  "postgresql",
  "postgres",
  "mongodb",
  "redis",
  "typescript",
  "javascript",
  "node.js",
  "nodejs",
  "python",
  "go",
  "rust",
  "react",
  "vue",
  "svelte",
  "express",
  "fastify",
  "docker",
  "kubernetes",
  "systemd",
  "nginx",
  "ollama",
  "mcp",
  "json-rpc",
  "sse",
  "websocket",
  "jwt",
  "oauth",
  "fts",
  "wal",
  "sqlite-vec",
  "nomic-embed-text",
  "zod",
  "vitest",
  "jest",
  "tsx",
  "xgboost",
  "grafana",
  "prometheus",
  "litellm",
  "openai",
  "anthropic",
  "claude",
  "gpt",
  "qwen",
  "git",
  "github",
  "npm",
  "yarn",
  "pnpm",
  "css",
  "html",
  "http",
  "https",
  "api",
  "rest",
  "graphql",
  "grpc",
  "pm2",
  "discord",
]);

/** Tool/service names (14 tools). */
const TOOL_NAMES = new Set([
  "engram",
  "engram-vec",
  "sparrow",
  "codex",
  "openclaw",
  "cortex",
  "pushover",
  "finnhub",
  "signalsquawk",
  "ib-gateway",
  "litellm",
  "claude-code",
  "cursor",
  "pm2",
]);

// ─── File path regex ────────────────────────────────────────────────

/** Matches file paths starting with common prefixes. */
const FILE_PATH_RE =
  /(?:\/home\/\S+|~\/\S+|\.\/\S+|(?<!\w)src\/\S+|(?<!\w)dist\/\S+|(?<!\w)tests?\/\S+)/g;

// ─── Decision pattern regex ─────────────────────────────────────────

const PATTERN_RE =
  /\b(lifecycle|preflight|confidence scor\w+|knowledge graph|entity extract\w+|graph expan\w+|backfill|migration|schema|polling|dedup\w*|rate.?limit\w*|token budget\w*|staleness|supersed\w+|deprecat\w+|webhook)\b/gi;

// ─── Core Functions ─────────────────────────────────────────────────

/**
 * Extract entities from observation title + content using 5-pass regex extraction.
 * Returns deduplicated entities with normalized names.
 */
export function extractEntities(
  title: string,
  content: string
): ExtractedEntity[] {
  const text = `${title}\n${content}`;
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  // Pass 1: Project names (from known set)
  for (const project of KNOWN_PROJECTS) {
    const re = new RegExp(`\\b${escapeRegex(project)}\\b`, "gi");
    if (re.test(text)) {
      addEntity(entities, seen, "project", project, []);
    }
  }

  // Pass 2: File paths (skip URLs)
  const pathMatches = text.match(FILE_PATH_RE) || [];
  for (const p of pathMatches) {
    // Skip URLs
    const idx = text.indexOf(p);
    if (idx > 0) {
      // Check if preceded by http:// or https://
      const before = text.slice(Math.max(0, idx - 10), idx);
      if (/https?:\/\/\S*$/.test(before)) continue;
    }
    // Strip trailing punctuation
    const cleaned = p.replace(/[,;)}\]'"]+$/, "");
    addEntity(entities, seen, "file_path", cleaned, []);
  }

  // Pass 3: Technology terms (word splitting + dictionary lookup)
  const words = text.toLowerCase().split(/[\s,;:()\[\]{}"'`]+/);
  for (const word of words) {
    const stripped = word.replace(/[^a-z0-9._-]/g, "");
    if (stripped && TECH_TERMS.has(stripped)) {
      addEntity(entities, seen, "technology", stripped, []);
    }
  }

  // Pass 4: Tool/service names
  for (const tool of TOOL_NAMES) {
    const re = new RegExp(`\\b${escapeRegex(tool)}\\b`, "gi");
    if (re.test(text)) {
      addEntity(entities, seen, "tool", tool, []);
    }
  }

  // Pass 5: Decision patterns (domain-specific concepts)
  let match;
  // Reset regex state
  PATTERN_RE.lastIndex = 0;
  while ((match = PATTERN_RE.exec(text)) !== null) {
    addEntity(entities, seen, "pattern", match[1], []);
  }

  return entities;
}

/**
 * Normalize an entity name: lowercase, strip non-word chars (keep dots/slashes/hyphens),
 * collapse whitespace, trim.
 */
export function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s./-]/g, "") // keep word chars, dots, slashes, hyphens
    .replace(/\s+/g, " ")
    .trim();
}

/** Escape special regex characters in a string. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Internal Helpers ───────────────────────────────────────────────

function addEntity(
  entities: ExtractedEntity[],
  seen: Set<string>,
  type: EntityType,
  rawName: string,
  aliases: string[]
): void {
  const normalizedName = normalize(rawName);
  const key = `${type}:${normalizedName}`;
  if (seen.has(key)) return;
  seen.add(key);
  entities.push({ type, rawName, normalizedName, aliases });
}
