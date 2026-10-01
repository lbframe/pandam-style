import type {
  ArtifactResult,
  ProjectSession,
  PublicationReceipt,
  PublicationTicket,
  RevisionIdentity,
} from './index.js';

export type {
  ArtifactResult,
  PublicationReceipt,
  PublicationTicket,
  RevisionIdentity,
};

export interface HostBridge {
  readArtifact(
    revision: RevisionIdentity,
    moduleId: string,
  ): Promise<ArtifactResult>;
  preparePublication(revision: RevisionIdentity): Promise<PublicationTicket>;
  commitPrepared(ticket: PublicationTicket): Promise<PublicationReceipt>;
  abortPrepared(ticket: PublicationTicket): Promise<boolean>;
}

export function createHostBridge(project: ProjectSession): HostBridge;
