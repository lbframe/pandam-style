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
  projectId?: string;
  rootDir: string;
  definition: Definition;
  roots: readonly string[];
  outDir?: string;
  designSystemFile?: string;
  runtimeModule?: string;
  useCSSLayers?: boolean;
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
  readonly generationId: number | string;
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

export interface ArtifactResult {
  readonly source: string;
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

export interface PublicationTicket {
  readonly ticketId: string;
  readonly sessionId: string;
  readonly revision: RevisionIdentity;
  readonly candidateDigest: string;
  readonly state: 'prepared';
}

export interface ProjectSession {
  readonly projectId: string;
  readonly sessionId: string;
  initialize(): Promise<
    Readonly<Record<string, unknown>> & { revision: RevisionIdentity }
  >;
  applyChanges(
    transaction: MutationTransaction,
  ): Promise<
    Readonly<Record<string, unknown>> & { revision: RevisionIdentity }
  >;
  validate(
    revision: RevisionIdentity,
  ): Promise<DiagnosticsResult & Readonly<Record<string, unknown>>>;
  compile(revision: RevisionIdentity): Promise<PublicationReceipt>;
  current(): Promise<Readonly<Record<string, unknown>>>;
  agentResult(
    revision: RevisionIdentity,
    options?: { candidateLimit?: number },
  ): Promise<DiagnosticsResult | null>;
  candidateTokens(
    query: CandidateQuery,
  ): Promise<Readonly<Record<string, unknown>>>;
  requestFullAudit(
    revision: RevisionIdentity,
  ): Promise<Readonly<Record<string, unknown>>>;
  auditMutationSet(
    revision: RevisionIdentity,
  ): Promise<Readonly<Record<string, unknown>>>;
  watch(options?: Readonly<Record<string, unknown>>): Promise<unknown>;
  readArtifact(
    revision: RevisionIdentity,
    moduleId: string,
  ): Promise<ArtifactResult>;
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
