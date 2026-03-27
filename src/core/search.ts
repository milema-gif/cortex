import type Database from "better-sqlite3";
import { hybridSearch } from "../lib/engram-vec.js";
import { log } from "../lib/logger.js";
import { computeConfidence, addStalenessWarning } from "../core/lifecycle.js";
import { expandGraph, observationsForEntities } from "../core/graph.js";
import type { SearchResult, ScoringExplanation, ExcludedCandidate, SearchExplainResult } from "../types.js";

export interface SearchOptions {
  project?: string;
  limit?: number;
  explain?: boolean;
}

export interface McpContent {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Format a list of SearchResult into a numbered text block.
 */
function formatResults(results: SearchResult[], fallback: boolean): string {
  if (results.length === 0) {
    return "No results found.";
  }

  const prefix = fallback
    ? "[FTS-only fallback -- engram-vec unavailable]\n\n"
    : "";

  const lines = results.map((r, i) => {
    const typeTag = r.type ? `[${r.type}]` : "[unknown]";
    const title = r.title || "(untitled)";
    const project = r.project || "none";
    const score = r.score?.toFixed(4) ?? "0.0000";
    const source = r.source || "unknown";
    const graphTag = r.source === "graph-expanded" ? " [via graph]" : "";

    let preview = r.content || "";
    if (preview.length > 200) {
      preview = preview.slice(0, 197) + "...";
    }

    return [
      `${i + 1}. ${typeTag} ${title}${graphTag}`,
      `   Project: ${project} | Score: ${score} | Source: ${source}`,
      preview ? `   ${preview}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return prefix + lines.join("\n\n");
}

/**
 * Expand search results using the knowledge graph.
 * Finds entities connected to direct results, fetches their observations,
 * and appends them with discounted scores.
 * Gracefully degrades: if graph expansion fails, returns directResults unchanged.
 *
 * When explain is true, sets graph_expansion on explain data for each result.
 */
export function graphExpandResults(
  db: Database.Database,
  directResults: (SearchResult & { explain?: ScoringExplanation })[],
  limit: number,
  explain?: boolean
): (SearchResult & { explain?: ScoringExplanation })[] {
  try {
    if (directResults.length === 0) return directResults;

    // Mark direct results with graph_expansion = 0 when explain is enabled
    if (explain) {
      for (const r of directResults) {
        if (r.explain) {
          r.explain.graph_expansion = 0;
        }
      }
    }

    const directIds = new Set(directResults.map((r) => r.id));

    // Step 1: Get entity IDs linked to direct result observations
    const obsIdPlaceholders = directResults.map(() => "?").join(",");
    let seedEntityIds: number[];
    try {
      const entityRows = db
        .prepare(
          `SELECT DISTINCT entity_id FROM obs_entities WHERE observation_id IN (${obsIdPlaceholders})`
        )
        .all(...directResults.map((r) => r.id)) as Array<{ entity_id: number }>;
      seedEntityIds = entityRows.map((r) => r.entity_id);
    } catch {
      // obs_entities table might not exist
      return directResults;
    }

    // Step 2: No entities found -> return direct results
    if (seedEntityIds.length === 0) return directResults;

    // Step 3: Expand graph (depth=2, max=20)
    const expandedEntityIds = expandGraph(db, seedEntityIds, 2, 20);

    // Step 4: Get observation IDs for expanded entities
    const expandedObsIds = observationsForEntities(db, expandedEntityIds);

    // Step 5: Filter out observations already in direct results
    const newObsIds = expandedObsIds.filter((id) => !directIds.has(id));

    // Step 6: No new observations
    if (newObsIds.length === 0) return directResults;

    // Step 7: Fetch observation data for new IDs
    const newPlaceholders = newObsIds.map(() => "?").join(",");
    const newRows = db
      .prepare(
        `SELECT id, title, content, type, project, scope, created_at
         FROM observations
         WHERE id IN (${newPlaceholders}) AND deleted_at IS NULL`
      )
      .all(...newObsIds) as Array<{
      id: number;
      title: string;
      content: string | null;
      type: string | null;
      project: string | null;
      scope: string | null;
      created_at: string | null;
    }>;

    // Step 8: Score at 0.5x the lowest direct result score
    const lowestDirectScore = Math.min(...directResults.map((r) => r.score));
    const graphScore = lowestDirectScore * 0.5;

    // Step 9: Create SearchResult entries with source "graph-expanded"
    const graphResults: (SearchResult & { explain?: ScoringExplanation })[] = newRows.map((row) => {
      const result: SearchResult & { explain?: ScoringExplanation } = {
        id: row.id,
        title: row.title,
        content: row.content,
        type: row.type,
        project: row.project,
        scope: row.scope,
        created_at: row.created_at,
        score: graphScore,
        ftsRank: null,
        vecRank: null,
        source: "graph-expanded" as const,
      };

      if (explain) {
        result.explain = {
          observation_id: row.id,
          fts_score: null,
          vector_score: null,
          rrf_combined: 0,
          graph_expansion: graphScore,
          lifecycle_confidence: 1,
          recency_boost: 1,
          final_composite: graphScore,
          source: "graph-expanded",
        };
      }

      return result;
    });

    // Step 10: Merge, deduplicate by ID (keep higher score), slice to limit
    const merged = [...directResults, ...graphResults];
    const deduped = new Map<number, SearchResult & { explain?: ScoringExplanation }>();
    for (const r of merged) {
      const existing = deduped.get(r.id);
      if (!existing || r.score > existing.score) {
        deduped.set(r.id, r);
      }
    }
    const final = Array.from(deduped.values());
    final.sort((a, b) => b.score - a.score);
    return final.slice(0, limit);
  } catch (err) {
    log("warn", "Graph expansion failed, returning direct results:", (err as Error).message);
    return directResults;
  }
}

/**
 * Filter out deprecated and superseded observations from hybrid search results.
 * Batch queries obs_lifecycle for excluded IDs.
 *
 * When explain is true, returns both kept and excluded candidates.
 */
function filterLifecycle(
  db: Database.Database,
  results: SearchResult[],
  explain?: boolean
): { kept: SearchResult[]; excluded: ExcludedCandidate[] } {
  if (results.length === 0) return { kept: results, excluded: [] };

  const ids = results.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");

  try {
    const excludedRows = db
      .prepare(
        `SELECT observation_id, status FROM obs_lifecycle
         WHERE observation_id IN (${placeholders})
           AND status IN ('deprecated', 'superseded')`
      )
      .all(...ids) as Array<{ observation_id: number; status: string }>;

    const excludedMap = new Map(excludedRows.map((r) => [r.observation_id, r.status]));
    const kept = results.filter((r) => !excludedMap.has(r.id));

    let excluded: ExcludedCandidate[] = [];
    if (explain) {
      excluded = results
        .filter((r) => excludedMap.has(r.id))
        .map((r) => ({
          observation_id: r.id,
          title: r.title,
          reason: excludedMap.get(r.id)!,
          original_score: r.score,
        }));
    }

    return { kept, excluded };
  } catch {
    // If obs_lifecycle table doesn't exist, return unfiltered
    return { kept: results, excluded: [] };
  }
}

/**
 * Enrich results with lifecycle-based composite scoring and staleness warnings.
 * Queries obs_lifecycle per result, computes composite score, re-sorts.
 *
 * When explain is true, attaches per-result ScoringExplanation.
 */
function enrichWithLifecycle(
  db: Database.Database,
  results: SearchResult[],
  explain?: boolean
): (SearchResult & { explain?: ScoringExplanation })[] {
  if (results.length === 0) return results;

  let lcStmt: Database.Statement | null = null;
  try {
    lcStmt = db.prepare(
      `SELECT status, confidence, last_verified_at
       FROM obs_lifecycle WHERE observation_id = ?`
    );
  } catch {
    // obs_lifecycle table doesn't exist -- return as-is
    return results;
  }

  const enriched = results.map((r) => {
    const lcRow = lcStmt!.get(r.id) as {
      status: string;
      confidence: number;
      last_verified_at: string | null;
    } | undefined;

    const status = lcRow?.status ?? "active";
    const confidence = lcRow?.confidence ?? 1.0;
    const lastVerifiedAt = lcRow?.last_verified_at ?? null;
    const createdAt = r.created_at ?? new Date().toISOString();

    // Compute lifecycle confidence
    const lcConfidence = computeConfidence({
      status,
      confidence,
      created_at: createdAt,
      last_verified_at: lastVerifiedAt,
    });

    // Recency boost: 1 + 0.5 * exp(-ageDays/30)
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
    const recencyBoost = 1 + 0.5 * Math.exp(-ageDays / 30);

    // Composite score
    const compositeScore = r.score * lcConfidence * recencyBoost;

    // Add staleness warning to title
    const enrichedTitle = addStalenessWarning(r.title, lastVerifiedAt, createdAt);

    const enrichedResult: SearchResult & { explain?: ScoringExplanation } = {
      ...r,
      title: enrichedTitle,
      score: compositeScore,
    };

    if (explain) {
      enrichedResult.explain = {
        observation_id: r.id,
        fts_score: r.ftsRank,
        vector_score: r.vecRank,
        rrf_combined: r.score,
        graph_expansion: 0, // Will be set by graphExpandResults if applicable
        lifecycle_confidence: lcConfidence,
        recency_boost: recencyBoost,
        final_composite: compositeScore,
        source: r.source,
      };
    }

    return enrichedResult;
  });

  // Re-sort by composite score descending
  enriched.sort((a, b) => b.score - a.score);

  return enriched;
}

/**
 * Direct FTS5 fallback query against observations_fts.
 * Used when engram-vec sidecar is unavailable.
 * Now lifecycle-aware: excludes deprecated/superseded via LEFT JOIN.
 */
function ftsFallback(
  db: Database.Database,
  query: string,
  options?: SearchOptions
): SearchResult[] {
  const limit = options?.limit ?? 10;

  // Sanitize FTS5 query: remove special chars that break MATCH
  const sanitized = query.replace(/[^\w\s]/g, " ").trim();
  if (!sanitized) return [];

  let sql = `
    SELECT o.id, o.title, o.content, o.type, o.project, o.scope, o.created_at,
           rank
    FROM observations o
    JOIN observations_fts f ON o.id = f.rowid
    LEFT JOIN obs_lifecycle lc ON o.id = lc.observation_id
    WHERE observations_fts MATCH ?
      AND o.deleted_at IS NULL
      AND COALESCE(lc.status, 'active') NOT IN ('deprecated', 'superseded')
  `;
  const params: unknown[] = [sanitized];

  if (options?.project) {
    sql += " AND o.project = ?";
    params.push(options.project);
  }

  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number;
    title: string;
    content: string | null;
    type: string | null;
    project: string | null;
    scope: string | null;
    created_at: string | null;
    rank: number;
  }>;

  const results: SearchResult[] = rows.map((row, i) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    type: row.type,
    project: row.project,
    scope: row.scope,
    created_at: row.created_at,
    score: 1 / (60 + i), // Simple RRF scoring
    ftsRank: row.rank,
    vecRank: null,
    source: "fts-fallback" as const,
  }));

  // Enrich with lifecycle composite scoring and staleness warnings
  return enrichWithLifecycle(db, results);
}

/**
 * Search coordinator with engram-vec delegation and FTS5 fallback.
 *
 * Primary path: delegates to engram-vec hybridSearch HTTP API.
 * Fallback: direct FTS5 query against the observations database.
 * Both paths are lifecycle-aware: deprecated/superseded excluded, results enriched.
 * Returns MCP-formatted content response.
 *
 * When explain=true, appends a second content block with per-result scoring breakdown.
 */
export async function search(
  db: Database.Database,
  query: string,
  options?: SearchOptions
): Promise<McpContent> {
  const explain = options?.explain ?? false;

  // Primary path: try engram-vec hybrid search
  try {
    let results = await hybridSearch(query, {
      limit: options?.limit,
      project: options?.project,
    });

    const totalCandidates = results.length;
    const { kept, excluded } = filterLifecycle(db, results, explain);
    results = kept;
    const totalAfterFilter = results.length;

    let enrichedResults = enrichWithLifecycle(db, results, explain);
    enrichedResults = graphExpandResults(db, enrichedResults, options?.limit ?? 10, explain);
    const totalAfterExpansion = enrichedResults.length;

    const text = formatResults(enrichedResults, false);
    const content: Array<{ type: "text"; text: string }> = [{ type: "text", text }];

    if (explain) {
      const explainResult: SearchExplainResult = {
        results: enrichedResults.map((r) => ({
          ...r,
          explain: (r as SearchResult & { explain?: ScoringExplanation }).explain,
        })),
        excluded,
        metadata: {
          total_candidates: totalCandidates,
          total_after_lifecycle_filter: totalAfterFilter,
          total_after_graph_expansion: totalAfterExpansion,
          search_source: "hybrid",
        },
      };
      content.push({ type: "text", text: JSON.stringify(explainResult, null, 2) });
    }

    return { content };
  } catch (hybridErr) {
    log("warn", "engram-vec unavailable, falling back to FTS:", (hybridErr as Error).message);
  }

  // Fallback: direct FTS5 query (lifecycle filtering built into SQL)
  try {
    let results = ftsFallback(db, query, options);
    results = graphExpandResults(db, results, options?.limit ?? 10);
    const text = formatResults(results, true);
    const content: Array<{ type: "text"; text: string }> = [{ type: "text", text }];

    if (explain) {
      // FTS fallback has lifecycle filtering in SQL, so no excluded candidates available
      const explainResult: SearchExplainResult = {
        results: results.map((r) => ({
          ...r,
          explain: (r as SearchResult & { explain?: ScoringExplanation }).explain,
        })),
        excluded: [],
        metadata: {
          total_candidates: results.length,
          total_after_lifecycle_filter: results.length,
          total_after_graph_expansion: results.length,
          search_source: "fts-fallback",
        },
      };
      content.push({ type: "text", text: JSON.stringify(explainResult, null, 2) });
    }

    return { content };
  } catch (ftsErr) {
    log("error", "FTS fallback also failed:", (ftsErr as Error).message);
    return {
      content: [{ type: "text", text: `Search failed: ${(ftsErr as Error).message}` }],
      isError: true,
    };
  }
}
