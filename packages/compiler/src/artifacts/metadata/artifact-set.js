/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createHash } from 'crypto';
import { diagnostic, Codes, PmsError } from '../../protocol/diagnostics';

const ARTIFACTS = ['designModule', 'declarations', 'manifest', 'css'];

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function identityPayload(identity) {
  return {
    systemId: identity.systemId,
    registryDigest: identity.registryDigest,
    abiVersion: identity.abiVersion,
    compilerContractVersion: identity.compilerContractVersion,
    manifestSchemaVersion: identity.manifestSchemaVersion,
  };
}

function artifactSetDigest(identity, artifacts) {
  const content = {
    ...identityPayload(identity),
    artifacts: Object.fromEntries(
      ARTIFACTS.map((name) => [
        name,
        {
          file: artifacts[name].file,
          sha256: artifacts[name].sha256,
          bytes: artifacts[name].bytes,
        },
      ]),
    ),
  };
  return sha256(JSON.stringify(content));
}

function mismatch(artifact, reason) {
  throw new PmsError([
    diagnostic({
      code: Codes.GENERATED_ARTIFACT_MISMATCH,
      phase: 'artifacts',
      rule: 'artifact-set.coherence',
      message: `Generated artifact set mismatch for ${artifact}: ${reason}.`,
      context: { artifact, reason },
    }),
  ]);
}

export function designDeclarationFile(designModuleFile) {
  return /\.(?:mjs|cjs|js)$/i.test(designModuleFile)
    ? designModuleFile.replace(/\.(?:mjs|cjs|js)$/i, '.d.ts')
    : `${designModuleFile}.d.ts`;
}

export function designSystemCssHeader(identity) {
  return `/* pandamstyle-design-system ${JSON.stringify(identityPayload(identity))} */`;
}

export function withDesignSystemCssIdentity(css, identity) {
  return `${designSystemCssHeader(identity)}\n${css}`;
}

/**
 * Validate every member against its recorded digest and common design identity.
 * `contents` is keyed by designModule, declarations, manifest and css.
 */
export function validateArtifactSet(metadata, contents) {
  if (metadata == null || typeof metadata !== 'object') {
    mismatch('artifacts.json', 'metadata is not an object');
  }
  const identity = {
    systemId: metadata.systemId,
    registryDigest: metadata.registryDigest,
    abiVersion: metadata.abiVersion,
    compilerContractVersion: metadata.compilerContractVersion,
    manifestSchemaVersion: metadata.manifestSchemaVersion,
  };
  const records = metadata.artifacts ?? {};
  for (const name of ARTIFACTS) {
    const record = records[name];
    const content = contents?.[name];
    if (record == null || typeof content !== 'string') {
      mismatch(name, 'artifact content or digest record is missing');
    }
    if (record.bytes !== Buffer.byteLength(content, 'utf8')) {
      mismatch(name, 'byte length does not match artifacts.json');
    }
    if (record.sha256 !== sha256(content)) {
      mismatch(name, 'SHA-256 does not match artifacts.json');
    }
  }
  if (metadata.artifactSetDigest !== artifactSetDigest(identity, records)) {
    mismatch('artifacts.json', 'artifact-set digest is invalid');
  }

  if (
    metadata.schemaVersion !== 1 ||
    metadata.abiVersion !== 1 ||
    metadata.compilerContractVersion !== 'pms-0.1' ||
    metadata.manifestSchemaVersion !== 1
  ) {
    mismatch('artifacts.json', 'unsupported schema or compiler identity');
  }

  let manifest;
  try {
    manifest = JSON.parse(contents.manifest);
  } catch {
    mismatch('manifest', 'JSON could not be parsed');
  }
  for (const key of Object.keys(identity)) {
    if (manifest[key] !== identity[key]) {
      mismatch('manifest', `identity field ${key} differs`);
    }
  }
  const markerMatch = contents.designModule.match(
    /export const __pandamstyle = (\{[\s\S]*?\n\});/,
  );
  let marker;
  try {
    marker = markerMatch == null ? null : JSON.parse(markerMatch[1]);
  } catch {
    marker = null;
  }
  if (
    marker == null ||
    marker.abiVersion !== identity.abiVersion ||
    marker.compilerContractVersion !== identity.compilerContractVersion ||
    marker.manifestSchemaVersion !== identity.manifestSchemaVersion ||
    marker.designSystem?.systemId !== identity.systemId ||
    marker.designSystem?.registryDigest !== identity.registryDigest ||
    marker.capabilities?.slots !== true ||
    marker.capabilities?.compoundVariants !== true ||
    marker.capabilities?.patterns !== true ||
    marker.capabilities?.rawDynamicStyles !== false
  ) {
    mismatch('designModule', 'generated identity marker differs');
  }
  for (const [field, value] of Object.entries(identity)) {
    if (
      !contents.declarations.includes(`${field}: ${JSON.stringify(value)};`)
    ) {
      mismatch('declarations', `identity field ${field} differs`);
    }
  }
  if (!contents.css.startsWith(`${designSystemCssHeader(identity)}\n`)) {
    mismatch('css', 'design-system identity header differs');
  }
  return true;
}

/** Build the immutable metadata member for one fully rendered artifact set. */
export function createArtifactSet(
  snapshot,
  {
    designModuleFile,
    declarationsFile,
    designModule,
    declarations,
    manifest,
    css,
  },
) {
  const identity = identityPayload(snapshot.identity);
  const files = {
    designModule: designModuleFile,
    declarations: declarationsFile,
    manifest: 'manifest.json',
    css: 'styles.css',
  };
  const contents = { designModule, declarations, manifest, css };
  const artifacts = Object.fromEntries(
    ARTIFACTS.map((name) => [
      name,
      {
        file: files[name],
        sha256: sha256(contents[name]),
        bytes: Buffer.byteLength(contents[name], 'utf8'),
      },
    ]),
  );
  const metadata = {
    schemaVersion: 1,
    ...identity,
    artifactSetDigest: artifactSetDigest(identity, artifacts),
    artifacts,
  };
  validateArtifactSet(metadata, contents);
  const text = `${JSON.stringify(metadata, null, 2)}\n`;
  return Object.freeze({ metadata, text, contents: Object.freeze(contents) });
}
