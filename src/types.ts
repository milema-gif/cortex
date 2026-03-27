export interface SearchResult {
  id: number;
  title: string;
  content: string | null;
  type: string | null;
  project: string | null;
  scope: string | null;
  created_at: string | null;
  score: number;
  ftsRank: number | null;
  vecRank: number | null;
  source: "both" | "fts" | "vec" | "fts-fallback" | "graph-expanded";
}

export type HealthLevel = 'healthy' | 'degraded' | 'blocked';

export type LifecycleStatus = 'active' | 'superseded' | 'deprecated' | 'uncertain';

export interface LifecycleRow {
  observation_id: number;
  status: LifecycleStatus;
  confidence: number;
  last_verified_at: string | null;
  supersedes_id: number | null;
  superseded_by_id: number | null;
  deprecation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface LifecycleInfo {
  status: LifecycleStatus;
  confidence: number;
  computedConfidence: number;
  lastVerifiedAt: string | null;
  isStale: boolean;
  staleDays: number | null;
}

export interface ConflictMatch {
  id: number;
  title: string;
  similarity: string;
}

export interface SyncFailureRow {
  observation_id: number;
  attempt_count: number;
  last_error: string;
  last_attempt_at: string;
  first_failed_at: string;
  status: 'pending' | 'parked';
}

export interface SyncHealth {
  pending_count: number;
  parked_count: number;
  oldest_pending_age: string | null;
  last_successful_sync: string | null;
  total_retry_attempts: number;
}

export interface ScoringExplanation {
  observation_id: number;
  fts_score: number | null;       // Raw FTS rank (from ftsRank)
  vector_score: number | null;    // Raw vector rank (from vecRank)
  rrf_combined: number;           // Score after RRF fusion (the initial r.score from hybridSearch)
  graph_expansion: number;        // 0 for direct results; for graph-expanded: the discount factor applied
  lifecycle_confidence: number;   // Output of computeConfidence() -- the multiplier applied
  recency_boost: number;          // The 1 + 0.5*exp(-ageDays/30) factor
  final_composite: number;        // The final score after all multipliers
  source: string;                 // "both" | "fts" | "vec" | "fts-fallback" | "graph-expanded"
}

export interface ExcludedCandidate {
  observation_id: number;
  title: string;
  reason: string;    // "deprecated" | "superseded" | "lifecycle_zero_confidence"
  original_score: number;
}

export interface SearchExplainResult {
  results: Array<SearchResult & { explain?: ScoringExplanation }>;
  excluded: ExcludedCandidate[];
  metadata: {
    total_candidates: number;
    total_after_lifecycle_filter: number;
    total_after_graph_expansion: number;
    search_source: "hybrid" | "fts-fallback";
  };
}

export interface ReconcileResult {
  success: boolean;
  message: string;
  health: HealthLevel;
}

export interface StatusReport {
  health: HealthLevel;
  db: {
    status: string;
    observations?: number;
    embedded?: number;
    error?: string;
  };
  engram_vec: {
    status: string;
    [key: string]: unknown;
  };
  ollama: string;
  cortex_tables: Record<string, number | "not_created">;
  sync_health?: SyncHealth;
}
