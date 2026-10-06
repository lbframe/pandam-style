import type {
  AcceptedArtifactResult,
  AcceptedSnapshot,
  AcceptedSnapshotPin,
  AcceptedSnapshotPinIdentity,
  AcceptedSnapshotRetentionStats,
  ArtifactResult,
  GeneratedArtifactSet,
  ProjectSession,
  PublicationReceipt,
  PublicationTicket,
  RevisionIdentity,
} from './index.js';

export type {
  AcceptedArtifactResult,
  AcceptedSnapshot,
  AcceptedSnapshotPin,
  AcceptedSnapshotPinIdentity,
  AcceptedSnapshotRetentionStats,
  ArtifactResult,
  GeneratedArtifactSet,
  PublicationReceipt,
  PublicationTicket,
  RevisionIdentity,
};

export interface HostBridge {
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
  pinAcceptedSnapshot(
    revision: RevisionIdentity,
    options: { readonly owner: string },
  ): Promise<AcceptedSnapshotPin>;
  readAcceptedArtifact(
    pin: AcceptedSnapshotPinIdentity,
    moduleId: string,
    sourceDigest: string,
  ): Promise<AcceptedArtifactResult>;
  releaseAcceptedSnapshot(pin: AcceptedSnapshotPinIdentity): Promise<boolean>;
  acceptedSnapshotRetentionStats(): Promise<AcceptedSnapshotRetentionStats>;
}

export function createHostBridge(project: ProjectSession): HostBridge;
