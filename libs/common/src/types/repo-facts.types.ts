/**
 * Everything about a repository that is **derivable from the AST**, and
 * therefore must never be asked of a model.
 *
 * The reports this project wants to produce read as credible because most of
 * what they assert is checkable fact and the rest is judgment grounded in it.
 * The pipeline had that backwards: it asked an LLM to *guess* the framework, the
 * entry points, the module graph, the routes and the complexity hotspots — all
 * of which the code graph already knows for free and exactly — and then rendered
 * the judgment into a fixed table.
 *
 * Two consequences of moving these here:
 *
 *  1. They stop being wrong. A module edge drawn from `getFileDependencies` is
 *     an import that exists. This is what makes "the diagrams can't hallucinate"
 *     true rather than aspirational — until now diagram #1 was drawn from an
 *     LLM-invented `module_dependencies[]`.
 *  2. They stop costing tokens, and they free the model to do the part it is
 *     actually good at: explaining *why* the structure looks like this.
 *
 * Computed once per run in the orchestrator, where the graph is already hot, and
 * published to Redis under `job:{runKey}:repo_facts`. Zero LLM calls.
 */

/** Free counts — the opening table of the report. */
export interface RepoStats {
  files: number;
  nodes: number;
  edges: number;
  /** Physical lines across indexed source files. */
  linesOfCode: number;
  sizeBytes: number;
}

export interface LanguageBreakdown {
  language: string;
  files: number;
}

/** A real route, from the graph's routing manifest — not a guessed endpoint. */
export interface RouteFact {
  url: string;
  handler: string;
  file: string;
  line: number;
  kind: string;
}

/**
 * A top-level source directory, treated as a module. This is the skeleton of
 * the per-component breakdown: the file list, size and public surface are facts;
 * only the one-line responsibility needs a model.
 */
export interface ModuleFact {
  name: string;
  files: number;
  linesOfCode: number;
  /** Representative file paths, capped — enough to orient, not a dump. */
  sampleFiles: string[];
  /** Public surface, capped. */
  exports: string[];
}

/** A real import edge between two modules, aggregated and weighted. */
export interface ModuleEdgeFact {
  from: string;
  to: string;
  /** How many file-level imports this module-level edge aggregates. */
  weight: number;
}

/** A symbol the graph says is heavily connected — measured, not guessed. */
export interface ComplexityHotspot {
  symbol: string;
  file: string;
  line: number;
  callers: number;
  callees: number;
  depth: number;
}

export interface DeadCodeFact {
  symbol: string;
  file: string;
  line: number;
  kind: string;
}

export interface RepoFacts {
  /** `{jobId}-{epoch}` — the run these facts describe. */
  runKey: string;
  stats: RepoStats;
  languages: LanguageBreakdown[];
  dominantLanguage: string | null;
  /** From getDetectedFrameworks() — replaces the architecture agent's guess. */
  frameworks: string[];
  /** Replaces the security agent's guessed `sensitive_endpoints`. */
  routes: RouteFact[];
  totalRoutes: number;
  modules: ModuleFact[];
  /** Replaces the architecture agent's guessed `module_dependencies`. */
  moduleDependencies: ModuleEdgeFact[];
  /** Replaces the quality agent's guessed `complexity_hotspots`. */
  complexityHotspots: ComplexityHotspot[];
  /** Real findings the pipeline never surfaced before. */
  circularDependencies: string[][];
  deadCode: DeadCodeFact[];
  /** Set when a fact could not be computed — surfaced, never silently empty. */
  degraded: string[];
}
