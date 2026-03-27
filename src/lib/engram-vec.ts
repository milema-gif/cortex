import { config } from "../config.js";
import type { SearchResult } from "../types.js";

export interface HybridSearchOptions {
  limit?: number;
  project?: string;
}

/**
 * Search memories via engram-vec sidecar's hybrid FTS5+vector search.
 * Delegates all search logic to the existing engram-vec HTTP API.
 */
export async function hybridSearch(
  query: string,
  options?: HybridSearchOptions
): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(options?.limit ?? 10),
  });
  if (options?.project) {
    params.set("project", options.project);
  }

  const resp = await fetch(`${config.engramVecUrl}/search?${params}`);
  if (!resp.ok) {
    throw new Error(
      `engram-vec search failed: HTTP ${resp.status} ${resp.statusText}`
    );
  }

  const data = (await resp.json()) as { results: SearchResult[] };
  return data.results;
}

/**
 * Get engram-vec sidecar status (health, embedding stats, etc.).
 */
export async function getEngramVecStatus(): Promise<Record<string, unknown>> {
  const resp = await fetch(`${config.engramVecUrl}/status`);
  if (!resp.ok) {
    throw new Error(
      `engram-vec status failed: HTTP ${resp.status} ${resp.statusText}`
    );
  }
  return (await resp.json()) as Record<string, unknown>;
}
