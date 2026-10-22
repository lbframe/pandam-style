// Generated from the AG-01.1 operation registry by
// packages/compiler/src/agent/codegen.js. Do not edit: regenerate with
// PMS_UPDATE_AGENT_TYPES=1 and the agent contract suite.

/** A list record: a v1 diagnostic, candidate, affected entry or description, never reshaped. */
export type AgentRecord = { readonly [key: string]: unknown };

/** `protocol.operations` (implemented, AG-01.1). */
export type ProtocolOperationsInput = {
  readonly protocolVersions?: readonly number[];
  readonly names?: readonly string[];
  readonly page?: {
    readonly offset: number;
    readonly limit: number;
  };
};
export type ProtocolOperationsOutput = {
  readonly protocol: 'pandamstyle-agent';
  readonly protocolVersion: 1;
  readonly views: ReadonlyArray<'compact' | 'detail'>;
  readonly limits: {
    readonly stringLengthUnit: 'json-utf8-bytes';
    readonly request: {
      readonly maxRequestBytes: number;
      readonly maxDepth: number;
      readonly maxStringBytes: number;
      readonly maxArrayItems: number;
    };
    readonly compact: {
      readonly maxResponseBytes: number;
      readonly recordCeiling: number;
      readonly floor: number;
      readonly frameMax: number;
      readonly pageLimit: number;
      readonly candidatesPerDiagnostic: number;
      readonly affectedEntries: number;
    };
    readonly detail: {
      readonly maxResponseBytes: number;
      readonly recordCeiling: number;
      readonly floor: number;
      readonly frameMax: number;
      readonly pageLimit: number;
      readonly candidatesPerDiagnostic: number;
      readonly affectedEntries: number;
    };
  };
  readonly vocabularies: {
    readonly grants: ReadonlyArray<
      | 'consult'
      | 'publish'
      | 'mutate-sources'
      | 'extend-design-system'
      | 'materialize-audit'
      | 'load-config'
      | 'manage-session'
    >;
    readonly effects: ReadonlyArray<
      | 'reads-registry'
      | 'reads-sources'
      | 'reads-generated'
      | 'computes'
      | 'session-state'
      | 'session-lifecycle'
      | 'schedules'
      | 'writes-generated'
      | 'writes-audit'
      | 'writes-sources'
      | 'executes-config'
      | 'reads-owner-descriptors'
    >;
    readonly outcomes: ReadonlyArray<
      | 'success'
      | 'invalid-input'
      | 'constraint-violation'
      | 'unsupported-capability'
      | 'denied-access'
      | 'stale-revision'
      | 'cancelled'
      | 'internal-error'
      | 'owner-required'
    >;
    readonly stages: ReadonlyArray<'request' | 'bootstrap' | 'execution'>;
    readonly retry: ReadonlyArray<'never' | 'after-refresh' | 'same-request'>;
  };
  readonly granted: ReadonlyArray<
    | 'consult'
    | 'publish'
    | 'mutate-sources'
    | 'extend-design-system'
    | 'materialize-audit'
    | 'load-config'
    | 'manage-session'
  > | null;
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `session.status` (implemented, AG-01.1). */
export type SessionStatusInput = Record<string, never>;
export type SessionStatusOutput = {
  readonly initialized: boolean;
  readonly generationId: number | null;
};

/** `check` (implemented, AG-01.1). */
export type CheckInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly page?: {
    readonly offset: number;
    readonly limit: number;
  };
};
export type CheckOutput = {
  readonly document?: {
    readonly documentKind: 'pandamstyle-diagnostics-result';
    readonly schemaVersion: 1;
    readonly revision: {
      readonly projectId: string;
      readonly sessionId: string;
      readonly revisionId: number;
    };
    readonly designSystem: {
      readonly systemId: string | null;
      readonly registryDigest: string | null;
    };
    readonly abiVersion: 1;
    readonly ok: boolean;
    readonly completeness: {
      readonly status: 'complete' | 'partial' | 'unknown';
      readonly scope: 'declared-project';
      readonly discovery: 'full-discovery' | 'watcher' | 'verified-explicit';
      readonly evidence:
        | 'filesystem-scan'
        | 'watcher-journal'
        | 'host-reported-set';
      readonly resyncRequired: boolean;
    };
    readonly diagnostics: readonly AgentRecord[];
    readonly diagnosticsTotal: number;
    readonly diagnosticsTruncated: boolean;
    readonly affected: {
      readonly entries: readonly AgentRecord[];
      readonly total: number;
      readonly truncated: boolean;
    };
    readonly generation: {
      readonly published: boolean;
      readonly generationId: number | null;
      readonly artifactRevision: {
        readonly projectId: string;
        readonly sessionId: string;
        readonly revisionId: number;
      } | null;
      readonly artifactDigest: string | null;
      readonly associationRevision: {
        readonly projectId: string;
        readonly sessionId: string;
        readonly revisionId: number;
      } | null;
    };
    readonly milestones: {
      readonly diagnosticsReady: boolean;
      readonly generationReady: boolean;
      readonly generationCommitted: boolean;
      readonly auditReportReady: boolean;
    };
    readonly audit: {
      readonly requested: boolean;
      readonly materialized: boolean;
      readonly document: string | null;
    };
    readonly incremental: {
      readonly fullFallback: boolean;
      readonly reason: string | null;
    };
  };
  readonly page?: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `diagnostics.candidates` (implemented, AG-01.1). */
export type DiagnosticsCandidatesInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly domain:
    | {
        readonly kind: 'category-index';
        readonly index: number;
      }
    | {
        readonly kind: 'category';
        readonly category: string;
      }
    | {
        readonly kind: 'from-diagnostic';
        readonly index: number;
      };
  readonly page?: {
    readonly offset: number;
    readonly limit: number;
  };
};
export type DiagnosticsCandidatesOutput = {
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
  readonly categoriesTotal: number;
  readonly categoryIndex: number | null;
};

/** `diagnostics.affected` (implemented, AG-01.1). */
export type DiagnosticsAffectedInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly page?: {
    readonly offset: number;
    readonly limit: number;
  };
};
export type DiagnosticsAffectedOutput = {
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `records.read` (implemented, AG-01.1). */
export type RecordsReadInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  } | null;
  readonly address:
    | {
        readonly kind: 'diagnostic';
        readonly index: number;
      }
    | {
        readonly kind: 'candidate';
        readonly domain:
          | {
              readonly kind: 'category-index';
              readonly index: number;
            }
          | {
              readonly kind: 'category';
              readonly category: string;
            }
          | {
              readonly kind: 'from-diagnostic';
              readonly index: number;
            };
        readonly index: number;
      }
    | {
        readonly kind: 'affected';
        readonly index: number;
      }
    | {
        readonly kind: 'bootstrap';
        readonly index: number;
      }
    | {
        readonly kind: 'audit-entry';
        readonly index: number;
      };
  readonly page: {
    readonly offset: number;
    readonly limit: number;
  };
};
export type RecordsReadOutput = {
  readonly chunk: string;
  readonly offset: number;
  readonly returned: number;
  readonly nextOffset: number | null;
  readonly bytes: number;
  readonly sha256: string;
};

/** `publish` (planned, AG-07.3 #25). */
export type PublishInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly candidateDigest: string;
};
export type PublishOutput = {
  readonly generationId: number;
  readonly artifactDigest: string;
  readonly identities: {
    readonly revision: {
      readonly projectId: string;
      readonly sessionId: string;
      readonly revisionId: number;
    };
    readonly designSystem: {
      readonly systemId: string;
      readonly registryDigest: string;
    } | null;
  };
};

/** `discover` (planned, AG-02.1 #11). */
export type DiscoverInput = {
  readonly include: ReadonlyArray<
    'versions' | 'hosts' | 'roots' | 'config-files' | 'artifacts'
  >;
};
export type DiscoverOutput = {
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `query` (planned, AG-04.1 #19). */
export type QueryInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly text: string;
  readonly kinds?: ReadonlyArray<
    'token' | 'recipe' | 'slot' | 'variant' | 'pattern' | 'condition' | 'theme'
  >;
  readonly page?: {
    readonly offset: number;
    readonly limit: number;
  };
};
export type QueryOutput = {
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `describe` (planned, AG-03.2 #13). */
export type DescribeInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly entity: {
    readonly kind:
      | 'token'
      | 'recipe'
      | 'slot'
      | 'variant'
      | 'pattern'
      | 'condition'
      | 'theme';
    readonly id: string;
  };
};
export type DescribeOutput = {
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `context` (planned, AG-05.1 #20). */
export type ContextInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly task: {
    readonly files?: readonly string[];
    readonly entities?: readonly string[];
  };
  readonly budgetBytes: number;
};
export type ContextOutput = {
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
  readonly omitted: number;
};

/** `impact` (planned, AG-09.1 #27). */
export type ImpactInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly entities: readonly string[];
  readonly page?: {
    readonly offset: number;
    readonly limit: number;
  };
};
export type ImpactOutput = {
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `repair.propose` (planned, AG-07.2 #24). */
export type RepairProposeInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly diagnostics: readonly number[];
  readonly page?: {
    readonly offset: number;
    readonly limit: number;
  };
};
export type RepairProposeOutput = {
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `repair.apply` (planned, AG-07.3 #25). */
export type RepairApplyInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly scope: readonly string[];
};
export type RepairApplyOutput = {
  readonly revision: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly receipt: {
    readonly written: readonly string[];
    readonly digest: string;
  };
};

/** `extend.propose` (planned, AG-08.1 #26). */
export type ExtendProposeInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly request: {
    readonly kind:
      | 'token'
      | 'recipe'
      | 'variant'
      | 'pattern'
      | 'condition'
      | 'theme';
    readonly name: string;
    readonly rationale: string;
  };
};
export type ExtendProposeOutput = {
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `extend.apply` (planned, AG-08.1 #26). */
export type ExtendApplyInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly proposalId: string;
  readonly proposalDigest: string;
};
export type ExtendApplyOutput = {
  readonly revision: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly receipt: {
    readonly written: readonly string[];
    readonly digest: string;
  };
};

/** `session.open` (planned, AG-02.1 #11). */
export type SessionOpenInput = {
  readonly config: string;
  readonly mode: 'standalone';
};
export type SessionOpenOutput = {
  readonly identities: {
    readonly revision: {
      readonly projectId: string;
      readonly sessionId: string;
      readonly revisionId: number;
    };
    readonly designSystem: {
      readonly systemId: string;
      readonly registryDigest: string;
    } | null;
  };
};

/** `session.attach` (implemented, AG-02.1 #11). */
export type SessionAttachInput = {
  readonly projectId?: string;
  readonly outDir?: string;
  readonly protocolVersions: readonly number[];
};
export type SessionAttachOutput = {
  readonly identities: {
    readonly projectId?: string;
    readonly sessionId?: string;
    readonly revision?: {
      readonly projectId: string;
      readonly sessionId: string;
      readonly revisionId: number;
    };
    readonly designSystem?: {
      readonly systemId: string;
      readonly registryDigest: string;
    };
    readonly lastValidDesignSystem?: {
      readonly systemId: string;
      readonly registryDigest: string;
      readonly derivedFromRevision: {
        readonly projectId: string;
        readonly sessionId: string;
        readonly revisionId: number;
      };
    };
  };
  readonly granted: ReadonlyArray<
    | 'consult'
    | 'publish'
    | 'mutate-sources'
    | 'extend-design-system'
    | 'materialize-audit'
    | 'load-config'
    | 'manage-session'
  >;
  readonly previousSessionId: string | null;
};

/** `session.close` (planned, AG-10.1 #29). */
export type SessionCloseInput = {
  readonly sessionId: string;
};
export type SessionCloseOutput = {
  readonly closed: true;
};

/** `session.apply-changes` (planned, AG-10.1 #29). */
export type SessionApplyChangesInput = {
  readonly baseRevision: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly mode: 'full-discovery' | 'verified-explicit';
  readonly changed: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly renamed: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
  }>;
};
export type SessionApplyChangesOutput = {
  readonly revision: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
};

/** `audit.read` (implemented, AG-01.2 #9). */
export type AuditReadInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
};
export type AuditReadOutput = {
  readonly canonical: {
    readonly documentKind: 'pandamstyle-coverage-report';
    readonly schemaVersion: 1;
    readonly generationId: number | null;
    readonly bytes: number;
    readonly sha256: string;
  } | null;
  readonly artifacts: ReadonlyArray<{
    readonly location: 'generation' | 'audit-directory';
    readonly path: string;
    readonly status: 'fresh' | 'stale' | 'missing' | 'unreadable';
    readonly reason:
      | 'revision-invalid'
      | 'size-differs'
      | 'content-differs'
      | 'not-regular-file'
      | 'directory-not-directory'
      | 'read-failed'
      | 'anchoring-unavailable'
      | null;
    readonly bytes: number | null;
    readonly sha256: string | null;
  }>;
};

/** `audit.compute` (implemented, AG-01.2 #9). */
export type AuditComputeInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly page?: {
    readonly offset: number;
    readonly limit: number;
  };
};
export type AuditComputeOutput = {
  readonly audit?: {
    readonly kind: 'pandamstyle-agent-audit';
    readonly version: 1;
    readonly validation: {
      readonly ok: boolean;
    };
    readonly coverage: {
      readonly stage: 'none' | 'closure-partial' | 'closure' | 'analysed';
      readonly completeness: 'complete' | 'partial' | 'unknown';
      readonly coveredFiles: number | null;
      readonly knownEntries: number;
      readonly unknownEntries: number;
      readonly summary: {
        readonly entries: number;
        readonly pages: number;
        readonly designSystem: number;
        readonly failed: number;
        readonly withDiagnostics: number;
        readonly usedDesignSystem: number;
        readonly usedPmsHelpers: number;
        readonly ruleTotal: number;
        readonly relayChainEntries: number;
        readonly maxRelayChain: number;
      };
    };
    readonly limitations: ReadonlyArray<
      | 'validation-failed'
      | 'design-system-unavailable'
      | 'scan-failed'
      | 'closure-not-computed'
      | 'closure-incomplete'
      | 'analysis-not-run'
      | 'files-not-analysed'
      | 'failed-files-without-rules'
    >;
    readonly canonical: {
      readonly documentKind: 'pandamstyle-coverage-report';
      readonly schemaVersion: 1;
      readonly generationId: number | null;
      readonly bytes: number;
      readonly sha256: string;
    } | null;
  };
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `audit.materialize` (implemented, AG-01.2 #9). */
export type AuditMaterializeInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly expectedGenerationId: number | null;
};
export type AuditMaterializeOutput = {
  readonly receiptKind: 'pandamstyle-audit-receipt';
  readonly receiptVersion: 1;
  readonly operation: 'audit.materialize';
  readonly requestId: string | null;
  readonly revision: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly designSystem: {
    readonly systemId: string;
    readonly registryDigest: string;
  };
  readonly generationId: number | null;
  readonly location: 'audit-directory';
  readonly path: string;
  readonly documentKind: 'pandamstyle-coverage-report';
  readonly schemaVersion: 1;
  readonly bytes: number;
  readonly sha256: string;
  readonly entryCount: number;
};

/** `install.plan` (planned, AG-11.1 #30). */
export type InstallPlanInput = {
  readonly host: 'vite' | 'rsbuild' | 'next-webpack' | 'next-turbopack';
  readonly mode: 'dev' | 'build';
};
export type InstallPlanOutput = {
  readonly planId: string;
  readonly planDigest: string;
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `install.apply` (planned, AG-11.1 #30). */
export type InstallApplyInput = {
  readonly planId: string;
  readonly planDigest: string;
  readonly scope: readonly string[];
};
export type InstallApplyOutput = {
  readonly revision: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly receipt: {
    readonly written: readonly string[];
    readonly digest: string;
  };
};

/** `migration.plan` (planned, AG-11.1 #30). */
export type MigrationPlanInput = {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly scope: readonly string[];
};
export type MigrationPlanOutput = {
  readonly planId: string;
  readonly planDigest: string;
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** `migration.apply` (planned, AG-11.1 #30). */
export type MigrationApplyInput = {
  readonly planId: string;
  readonly planDigest: string;
  readonly scope: readonly string[];
};
export type MigrationApplyOutput = {
  readonly revision: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly receipt: {
    readonly written: readonly string[];
    readonly digest: string;
  };
};

/** `measurement.collect` (planned, AG-11.1 #30). */
export type MeasurementCollectInput = {
  readonly rev: {
    readonly projectId: string;
    readonly sessionId: string;
    readonly revisionId: number;
  };
  readonly metrics: ReadonlyArray<
    'compiler-cost' | 'artifact-size' | 'diagnostics' | 'gaps'
  >;
};
export type MeasurementCollectOutput = {
  readonly page: {
    readonly kind: 'pandamstyle-agent-page';
    readonly list:
      | 'diagnostics'
      | 'candidates'
      | 'affected'
      | 'bootstrap'
      | 'operations'
      | 'audit-entries';
    readonly offset: number;
    readonly records: readonly AgentRecord[];
    readonly total: number;
    readonly withheld: ReadonlyArray<{
      readonly address:
        | {
            readonly kind: 'diagnostic';
            readonly index: number;
          }
        | {
            readonly kind: 'candidate';
            readonly domain:
              | {
                  readonly kind: 'category-index';
                  readonly index: number;
                }
              | {
                  readonly kind: 'category';
                  readonly category: string;
                }
              | {
                  readonly kind: 'from-diagnostic';
                  readonly index: number;
                };
            readonly index: number;
          }
        | {
            readonly kind: 'affected';
            readonly index: number;
          }
        | {
            readonly kind: 'bootstrap';
            readonly index: number;
          }
        | {
            readonly kind: 'audit-entry';
            readonly index: number;
          };
      readonly code?: string;
      readonly severity?: 'error' | 'warning' | 'info';
      readonly bytes: number;
      readonly sha256: string;
    }>;
  };
};

/** The input type of every operation, by name. */
export interface OperationInputs {
  readonly 'protocol.operations': ProtocolOperationsInput;
  readonly 'session.status': SessionStatusInput;
  readonly check: CheckInput;
  readonly 'diagnostics.candidates': DiagnosticsCandidatesInput;
  readonly 'diagnostics.affected': DiagnosticsAffectedInput;
  readonly 'records.read': RecordsReadInput;
  readonly publish: PublishInput;
  readonly discover: DiscoverInput;
  readonly query: QueryInput;
  readonly describe: DescribeInput;
  readonly context: ContextInput;
  readonly impact: ImpactInput;
  readonly 'repair.propose': RepairProposeInput;
  readonly 'repair.apply': RepairApplyInput;
  readonly 'extend.propose': ExtendProposeInput;
  readonly 'extend.apply': ExtendApplyInput;
  readonly 'session.open': SessionOpenInput;
  readonly 'session.attach': SessionAttachInput;
  readonly 'session.close': SessionCloseInput;
  readonly 'session.apply-changes': SessionApplyChangesInput;
  readonly 'audit.read': AuditReadInput;
  readonly 'audit.compute': AuditComputeInput;
  readonly 'audit.materialize': AuditMaterializeInput;
  readonly 'install.plan': InstallPlanInput;
  readonly 'install.apply': InstallApplyInput;
  readonly 'migration.plan': MigrationPlanInput;
  readonly 'migration.apply': MigrationApplyInput;
  readonly 'measurement.collect': MeasurementCollectInput;
}

/** The result type of every implemented operation, by name. */
export interface OperationResults {
  readonly 'protocol.operations': ProtocolOperationsOutput;
  readonly 'session.status': SessionStatusOutput;
  readonly check: CheckOutput;
  readonly 'diagnostics.candidates': DiagnosticsCandidatesOutput;
  readonly 'diagnostics.affected': DiagnosticsAffectedOutput;
  readonly 'records.read': RecordsReadOutput;
  readonly 'session.attach': SessionAttachOutput;
  readonly 'audit.read': AuditReadOutput;
  readonly 'audit.compute': AuditComputeOutput;
  readonly 'audit.materialize': AuditMaterializeOutput;
}

/** A request. `input` is checked by the compiler, whatever its static type. */
export type AgentRequest = {
  [N in keyof OperationInputs]: {
    readonly protocol?: 'pandamstyle-agent';
    readonly protocolVersion: 1;
    readonly operation: N;
    readonly requestId?: string;
    readonly view?: 'compact' | 'detail';
    readonly maxResponseBytes?: number;
    readonly input?: OperationInputs[N];
  };
}[keyof OperationInputs];

/** The response frame shared by every operation. */
export type AgentEnvelopeFrame = {
  readonly protocol: 'pandamstyle-agent';
  readonly protocolVersion: 1;
  readonly operation?:
    | 'protocol.operations'
    | 'session.status'
    | 'check'
    | 'diagnostics.candidates'
    | 'diagnostics.affected'
    | 'records.read'
    | 'publish'
    | 'discover'
    | 'query'
    | 'describe'
    | 'context'
    | 'impact'
    | 'repair.propose'
    | 'repair.apply'
    | 'extend.propose'
    | 'extend.apply'
    | 'session.open'
    | 'session.attach'
    | 'session.close'
    | 'session.apply-changes'
    | 'audit.read'
    | 'audit.compute'
    | 'audit.materialize'
    | 'install.plan'
    | 'install.apply'
    | 'migration.plan'
    | 'migration.apply'
    | 'measurement.collect';
  readonly requestId?: string;
  readonly outcome:
    | 'success'
    | 'invalid-input'
    | 'constraint-violation'
    | 'unsupported-capability'
    | 'denied-access'
    | 'stale-revision'
    | 'cancelled'
    | 'internal-error'
    | 'owner-required';
  readonly identities: {
    readonly projectId?: string;
    readonly sessionId?: string;
    readonly revision?: {
      readonly projectId: string;
      readonly sessionId: string;
      readonly revisionId: number;
    };
    readonly designSystem?: {
      readonly systemId: string;
      readonly registryDigest: string;
    };
    readonly lastValidDesignSystem?: {
      readonly systemId: string;
      readonly registryDigest: string;
      readonly derivedFromRevision: {
        readonly projectId: string;
        readonly sessionId: string;
        readonly revisionId: number;
      };
    };
  };
  readonly diagnostics: readonly AgentRecord[];
  readonly diagnosticsTotal: number;
  readonly diagnosticsTruncated: boolean;
  readonly failure: {
    readonly stage: 'request' | 'bootstrap' | 'execution';
    readonly reason: string;
    readonly precondition:
      | 'session-initialized'
      | 'revision-validated'
      | 'design-system-current'
      | 'revision-valid'
      | 'output-lease-held'
      | null;
    readonly capability: string | null;
    readonly retry: 'never' | 'after-refresh' | 'same-request';
  } | null;
  readonly references: ReadonlyArray<
    | {
        readonly operation: 'check';
        readonly view: 'compact' | 'detail';
        readonly input: {
          readonly rev: {
            readonly projectId: string;
            readonly sessionId: string;
            readonly revisionId: number;
          };
          readonly page?: {
            readonly offset: number;
            readonly limit: number;
          };
        };
      }
    | {
        readonly operation: 'audit.compute';
        readonly view: 'compact' | 'detail';
        readonly input: {
          readonly rev: {
            readonly projectId: string;
            readonly sessionId: string;
            readonly revisionId: number;
          };
          readonly page?: {
            readonly offset: number;
            readonly limit: number;
          };
        };
      }
    | {
        readonly operation: 'diagnostics.candidates';
        readonly view: 'compact' | 'detail';
        readonly input: {
          readonly rev: {
            readonly projectId: string;
            readonly sessionId: string;
            readonly revisionId: number;
          };
          readonly domain:
            | {
                readonly kind: 'category-index';
                readonly index: number;
              }
            | {
                readonly kind: 'category';
                readonly category: string;
              }
            | {
                readonly kind: 'from-diagnostic';
                readonly index: number;
              };
          readonly page?: {
            readonly offset: number;
            readonly limit: number;
          };
        };
      }
    | {
        readonly operation: 'diagnostics.affected';
        readonly view: 'compact' | 'detail';
        readonly input: {
          readonly rev: {
            readonly projectId: string;
            readonly sessionId: string;
            readonly revisionId: number;
          };
          readonly page?: {
            readonly offset: number;
            readonly limit: number;
          };
        };
      }
    | {
        readonly operation: 'records.read';
        readonly view: 'compact' | 'detail';
        readonly input: {
          readonly rev: {
            readonly projectId: string;
            readonly sessionId: string;
            readonly revisionId: number;
          } | null;
          readonly address:
            | {
                readonly kind: 'diagnostic';
                readonly index: number;
              }
            | {
                readonly kind: 'candidate';
                readonly domain:
                  | {
                      readonly kind: 'category-index';
                      readonly index: number;
                    }
                  | {
                      readonly kind: 'category';
                      readonly category: string;
                    }
                  | {
                      readonly kind: 'from-diagnostic';
                      readonly index: number;
                    };
                readonly index: number;
              }
            | {
                readonly kind: 'affected';
                readonly index: number;
              }
            | {
                readonly kind: 'bootstrap';
                readonly index: number;
              }
            | {
                readonly kind: 'audit-entry';
                readonly index: number;
              };
          readonly page: {
            readonly offset: number;
            readonly limit: number;
          };
        };
      }
    | {
        readonly operation: 'protocol.operations';
        readonly view: 'compact' | 'detail';
        readonly input: {
          readonly protocolVersions?: readonly number[];
          readonly names?: readonly string[];
          readonly page?: {
            readonly offset: number;
            readonly limit: number;
          };
        };
      }
  >;
  readonly view: 'compact' | 'detail';
  readonly page: {
    readonly offset: number;
    readonly limit: number;
    readonly returned: number;
    readonly nextOffset: number | null;
    readonly total: number;
    readonly truncated: boolean;
  } | null;
  readonly withheld: ReadonlyArray<{
    readonly address:
      | {
          readonly kind: 'diagnostic';
          readonly index: number;
        }
      | {
          readonly kind: 'candidate';
          readonly domain:
            | {
                readonly kind: 'category-index';
                readonly index: number;
              }
            | {
                readonly kind: 'category';
                readonly category: string;
              }
            | {
                readonly kind: 'from-diagnostic';
                readonly index: number;
              };
          readonly index: number;
        }
      | {
          readonly kind: 'affected';
          readonly index: number;
        }
      | {
          readonly kind: 'bootstrap';
          readonly index: number;
        }
      | {
          readonly kind: 'audit-entry';
          readonly index: number;
        };
    readonly code?: string;
    readonly severity?: 'error' | 'warning' | 'info';
    readonly bytes: number;
    readonly sha256: string;
  }>;
  readonly limits: {
    readonly maxResponseBytes: number;
    readonly responseBytes: number;
    readonly floor: number;
    readonly frameMax: number;
  };
};

/** A response; `result` is null whenever the operation produced none. */
export type AgentEnvelope<R> = AgentEnvelopeFrame & {
  readonly result: R | null;
};

export type AgentResponse<N extends keyof OperationResults> = AgentEnvelope<
  OperationResults[N]
>;
