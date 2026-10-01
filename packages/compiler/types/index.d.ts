export interface RevisionIdentity {
  readonly projectId: string;
  readonly sessionId: string;
  readonly revisionId: number;
}

export interface DesignSystemIdentity {
  readonly systemId: string;
  readonly registryDigest: string;
}

export interface ProjectConfig {
  readonly projectId?: string;
  readonly rootDir: string;
  readonly definition: Definition;
  readonly roots: readonly string[];
  readonly outDir?: string;
  readonly designSystemFile?: string;
  readonly useCSSLayers?: boolean;
  readonly engineOptions?: Readonly<Record<string, unknown>>;
  readonly auditPolicy?: 'reference' | 'inline';
}

export interface Definition {
  readonly systemId: string;
  readonly [key: string]: unknown;
}

export interface MutationTransaction {
  readonly baseRevision: RevisionIdentity;
  readonly mode: 'verified-explicit' | 'watcher' | 'full-discovery';
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  /**
   * Optional host-provided source bytes for changed/added paths. The compiler
   * treats these bytes as the source input for this revision and retains them
   * only in the owning project session until that path is changed again.
   */
  readonly sourceOverlays?: readonly SourceOverlay[];
  readonly definition?: Definition;
  readonly config?: ProjectConfigChanges;
  readonly forceFullDiscovery?: boolean;
}

export interface SourceOverlay {
  /** Project-relative POSIX path, also present in changed/added/renamed.to. */
  readonly file: string;
  /** Exact source text supplied by the host for this revision. */
  readonly source: string;
}

export interface ProjectConfigChanges {
  readonly roots?: readonly string[];
  readonly definition?: Definition;
  readonly designSystemFile?: string;
  readonly engineOptions?: Readonly<Record<string, unknown>>;
  readonly useCSSLayers?: boolean;
  readonly auditPolicy?: 'reference' | 'inline';
}

export interface ProjectRevisionResult {
  readonly revision: RevisionIdentity;
  readonly [key: string]: unknown;
}

export interface ProjectGeneration {
  readonly generationId: number;
  readonly artifactRevision: RevisionIdentity | null;
  readonly associationRevision: RevisionIdentity | null;
  readonly artifactDigest: string;
  readonly designSystem: Readonly<{
    systemId: string;
    registryDigest: string | null;
  }> | null;
  readonly publication: Readonly<Record<string, unknown>> | null;
}

export interface ProjectCurrent {
  readonly revision: RevisionIdentity | null;
  readonly generation: ProjectGeneration | null;
}

export interface WatchTransaction {
  readonly mode: 'watcher';
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: readonly { readonly from: string; readonly to: string }[];
  readonly forceFullDiscovery: boolean;
}

export interface WatcherHandle {
  readonly name: string;
  readonly mode: 'watcher';
  readonly established: boolean;
  readonly startFailures: readonly Readonly<{ root: string; code: string }>[];
  flush(): Promise<ProjectRevisionResult | null>;
  stats(): Readonly<Record<string, number | boolean>>;
  close(): void;
}

export interface WatchOptions {
  readonly debounceMs?: number;
  readonly maxPending?: number;
  readonly onRevision?: (result: ProjectRevisionResult) => void;
  readonly onError?: (error: unknown) => void;
  readonly onResync?: (reason: string, result: ProjectRevisionResult) => void;
}

export interface DiagnosticSource {
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly endLine: number | null;
  readonly endColumn: number | null;
  readonly label: string | null;
}

export interface Diagnostic {
  readonly schemaVersion: 1;
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly phase: string | null;
  readonly rule: string | null;
  readonly message: string;
  readonly source: DiagnosticSource;
  readonly role: string | null;
  readonly context: Readonly<Record<string, unknown>>;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly candidates: readonly Readonly<Record<string, unknown>>[];
  readonly candidatesTotal: number | null;
  readonly candidatesTruncated: boolean;
  readonly candidatesQuery: Readonly<Record<string, unknown>>;
  readonly repair: Readonly<Record<string, unknown>>;
  readonly autofix: null;
  readonly affectedRegion: Readonly<Record<string, unknown>>;
  readonly coverage: Readonly<Record<string, unknown>>;
  readonly revision: RevisionIdentity;
}

export interface DiagnosticsResult {
  readonly documentKind: 'pandamstyle-diagnostics-result';
  readonly schemaVersion: 1;
  readonly revision: RevisionIdentity;
  readonly designSystem: DesignSystemIdentity;
  readonly abiVersion: 1;
  readonly ok: boolean;
  readonly completeness: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly Diagnostic[];
  readonly diagnosticsTotal: number;
  readonly diagnosticsTruncated: boolean;
  readonly affected: Readonly<Record<string, unknown>>;
  readonly generation: Readonly<Record<string, unknown>>;
  readonly milestones: Readonly<Record<string, boolean>>;
  readonly audit: Readonly<Record<string, unknown>>;
  readonly incremental: Readonly<Record<string, unknown>>;
}

export interface PublicationReceipt {
  readonly projectId: string;
  readonly sessionId: string;
  readonly revision: RevisionIdentity;
  readonly artifactRevision: RevisionIdentity;
  readonly artifactDigest: string;
  readonly associationRevision: RevisionIdentity;
  readonly generationId: number;
  readonly designSystem: DesignSystemIdentity;
  readonly abiVersion: 1;
  readonly publication: Readonly<Record<string, unknown>> | null;
}

export interface CandidateQuery {
  readonly revision: RevisionIdentity;
  readonly category?: string;
  readonly offset?: number;
  readonly limit?: number;
}

export interface CandidateToken {
  readonly tokenId: string;
  readonly category: string | null;
}

export interface CandidateTokenResult {
  readonly revision: RevisionIdentity;
  readonly category: string | null;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly truncated: boolean;
  readonly candidates: readonly CandidateToken[];
}

export interface MutationAuditResult {
  readonly revision: RevisionIdentity;
  readonly mode: string;
  readonly audited: boolean;
  readonly discrepancies: readonly Readonly<Record<string, unknown>>[];
  readonly declared: number;
  readonly note?: string;
}

export interface ArtifactResult {
  readonly source: string;
  /** SHA-256 digest of the exact source bytes compiled for this revision. */
  readonly sourceDigest: string;
  readonly javascript: string;
  readonly sourceMap: string | null;
  readonly css: readonly Readonly<{ file: string; content: string }>[];
  readonly dependencies: readonly string[];
  readonly revision: RevisionIdentity;
  readonly designSystem: Readonly<{
    systemId: string;
    registryDigest: string | null;
  }>;
  readonly abiVersion: 1;
}

export interface GeneratedArtifactFile {
  readonly file: string;
  readonly kind:
    | 'design-module'
    | 'declarations'
    | 'manifest'
    | 'css'
    | 'artifact-metadata';
  readonly content: string;
}

export interface GeneratedArtifactSet {
  readonly files: readonly GeneratedArtifactFile[];
  readonly revision: RevisionIdentity;
  readonly designSystem: Readonly<{
    systemId: string;
    registryDigest: string | null;
  }>;
  readonly abiVersion: 1;
}

export interface PublicationTicket {
  readonly ticketId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly revision: RevisionIdentity;
  readonly candidateDigest: string;
  readonly state: 'prepared';
}

export interface ProjectSession {
  readonly projectId: string;
  readonly sessionId: string;
  initialize(): Promise<ProjectRevisionResult>;
  applyChanges(
    transaction: MutationTransaction,
  ): Promise<ProjectRevisionResult>;
  validate(
    revision: RevisionIdentity,
  ): Promise<DiagnosticsResult & Readonly<Record<string, unknown>>>;
  compile(revision: RevisionIdentity): Promise<PublicationReceipt>;
  current(): Promise<ProjectCurrent>;
  agentResult(
    revision: RevisionIdentity,
    options?: { candidateLimit?: number },
  ): Promise<DiagnosticsResult | null>;
  candidateTokens(query: CandidateQuery): Promise<CandidateTokenResult>;
  requestFullAudit(
    revision: RevisionIdentity,
  ): Promise<
    Readonly<Record<string, unknown>> & { revision: RevisionIdentity }
  >;
  auditMutationSet(revision: RevisionIdentity): Promise<MutationAuditResult>;
  watch(options?: WatchOptions): Promise<WatcherHandle>;
  readArtifact(
    revision: RevisionIdentity,
    moduleId: string,
  ): Promise<ArtifactResult>;
  readGeneratedArtifacts(
    revision: RevisionIdentity,
  ): Promise<GeneratedArtifactSet>;
  preparePublication(revision: RevisionIdentity): Promise<PublicationTicket>;
  commitPrepared(ticket: PublicationTicket): Promise<PublicationReceipt>;
  abortPrepared(ticket: PublicationTicket): Promise<boolean>;
  close(): Promise<void>;
}

export class PmsError extends Error {
  readonly diagnostics: readonly Diagnostic[];
}

export const Codes: Readonly<Record<string, string>>;
export function formatDiagnostic(
  diagnostic: Readonly<Record<string, unknown>>,
): string;
export const COMPILER_ABI_VERSION: 1;
export const DIAGNOSTICS_RESULT_KIND: 'pandamstyle-diagnostics-result';
export const DIAGNOSTICS_RESULT_SCHEMA_VERSION: 1;
export function createProjectSession(config: ProjectConfig): ProjectSession;
