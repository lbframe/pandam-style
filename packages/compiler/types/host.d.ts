import type {
  ArtifactResult,
  ProjectSession,
  PublicationTicket,
  RevisionIdentity,
} from './index.js';

export type { ArtifactResult, PublicationTicket };

export interface HostBridge {
  readArtifact(
    revision: RevisionIdentity,
    moduleId: string,
  ): Promise<ArtifactResult>;
  preparePublication(revision: RevisionIdentity): Promise<PublicationTicket>;
  commitPrepared(ticket: PublicationTicket): Promise<unknown>;
  abortPrepared(ticket: PublicationTicket): Promise<boolean>;
}

export function createHostBridge(project: ProjectSession): HostBridge;
