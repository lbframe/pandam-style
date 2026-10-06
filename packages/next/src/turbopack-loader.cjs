/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { transportSourceMap } = require('./source-map.cjs');
const {
  request,
  readConnection,
  transportError,
  PROTOCOL_VERSION,
} = require('./transport-client.cjs');
const sameRevision = (a, b) =>
  a != null &&
  b != null &&
  a.projectId === b.projectId &&
  a.sessionId === b.sessionId &&
  a.revisionId === b.revisionId;

module.exports = function pandamStyleTurbopackLoader(input, inputMap) {
  const callback = this.async();
  const options = this.getOptions();
  const source = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  const sourceDigest = createHash('sha256')
    .update(source, 'utf8')
    .digest('hex');
  if (/[\\/]node_modules[\\/]/.test(this.resourcePath)) {
    callback(null, source, inputMap);
    return;
  }
  const addDependencies = (files) => {
    for (const file of files.filter((file) => typeof file === 'string'))
      this.addDependency(file);
  };
  // These dependencies are registered even if the current semantic revision
  // cannot transform. A repaired definition/status can retry unchanged source.
  addDependencies([
    options.credentialFile,
    options.statusFile,
    options.currentFile,
    options.definitionPath,
  ]);
  for (const root of options.roots ?? []) this.addContextDependency(root);
  const transform = async () => {
    if (options.protocolVersion !== PROTOCOL_VERSION)
      throw transportError(
        'PMS_TRANSPORT_PROTOCOL',
        'Unsupported loader protocol.',
      );
    const result = await request(
      options.credentialFile,
      'transform',
      {
        file: this.resourcePath,
        sourceDigest,
        snapshotId: null,
      },
      { projectId: options.projectId, sessionId: options.sessionId },
    );
    addDependencies(result.dependencies ?? []);
    if (result.passthrough === true) {
      callback(null, source, inputMap);
      return;
    }
    const artifact = result.artifact;
    const descriptor = result.descriptor;
    const sourceId = path
      .relative(readConnection(options.credentialFile).root, this.resourcePath)
      .split(path.sep)
      .join('/');
    if (
      artifact == null ||
      descriptor == null ||
      typeof artifact.javascript !== 'string' ||
      artifact.sourceDigest !== sourceDigest ||
      artifact.source !== sourceId ||
      artifact.abiVersion !== descriptor.abiVersion ||
      artifact.designSystem?.systemId !== descriptor.designSystem?.systemId ||
      artifact.designSystem?.registryDigest !==
        descriptor.designSystem?.registryDigest ||
      descriptor.protocolVersion !== PROTOCOL_VERSION ||
      descriptor.projectId !== options.projectId ||
      descriptor.sessionId !== options.sessionId ||
      !sameRevision(artifact.revision, descriptor.associationRevision) ||
      !sameRevision(result.revision, descriptor.associationRevision) ||
      (descriptor.accepted &&
        (artifact.provenance?.projectId !== descriptor.projectId ||
          artifact.provenance?.sessionId !== descriptor.sessionId ||
          artifact.provenance?.generationId !== descriptor.generationId ||
          artifact.provenance?.artifactDigest !== descriptor.artifactDigest ||
          artifact.provenance?.candidateDigest !== descriptor.candidateDigest ||
          !sameRevision(
            artifact.provenance?.artifactRevision,
            descriptor.artifactRevision,
          ) ||
          artifact.provenance?.snapshotId !== descriptor.snapshotId ||
          artifact.provenance?.canonicalSetDigest !==
            descriptor.canonicalSetDigest ||
          !sameRevision(
            artifact.provenance?.associationRevision,
            descriptor.associationRevision,
          )))
    )
      throw transportError(
        'PMS_TRANSPORT_IDENTITY',
        'Compiler artifact and immutable snapshot do not identify the exact loader source and association.',
      );
    const design = descriptor.files?.find(
      (member) => member.kind === 'design-module',
    );
    const css = descriptor.files?.find((member) => member.kind === 'css');
    if (
      design == null ||
      css == null ||
      design.path !== descriptor.designJS ||
      css.path !== descriptor.stylesCSS ||
      design.path !== path.join(descriptor.directory, design.file) ||
      css.path !== path.join(descriptor.directory, css.file)
    )
      throw transportError(
        'PMS_TRANSPORT_MIXED_PAIR',
        'Generated JavaScript and CSS must come from one immutable descriptor.',
      );
    const importPath = (file) => {
      const relative = path
        .relative(path.dirname(this.resourcePath), file)
        .split(path.sep)
        .join('/');
      return relative.startsWith('./') || relative.startsWith('../')
        ? relative
        : './' + relative;
    };
    let javascript = artifact.javascript;
    const edits = [];
    let previousStart = javascript.length;
    if (!Array.isArray(artifact.generatedImports))
      throw transportError(
        'PMS_TRANSPORT_PROTOCOL',
        'Compiler import provenance is unavailable.',
      );
    for (const reference of [...artifact.generatedImports].sort(
      (a, b) => b.start - a.start,
    )) {
      if (
        reference.kind !== 'design-module' ||
        !Number.isSafeInteger(reference.start) ||
        !Number.isSafeInteger(reference.end) ||
        reference.start < 0 ||
        reference.end <= reference.start ||
        reference.end > previousStart
      )
        throw transportError(
          'PMS_TRANSPORT_PROTOCOL',
          'Invalid compiler import provenance range.',
        );
      const replacement = JSON.stringify(importPath(descriptor.designJS));
      edits.push({ start: reference.start, end: reference.end, replacement });
      javascript =
        javascript.slice(0, reference.start) +
        replacement +
        javascript.slice(reference.end);
      previousStart = reference.start;
    }
    javascript +=
      '\nimport ' + JSON.stringify(importPath(descriptor.stylesCSS)) + ';\n';
    callback(
      null,
      javascript,
      transportSourceMap(
        artifact.sourceMap,
        artifact.javascript,
        edits,
        readConnection(options.credentialFile).root,
      ),
    );
  };
  transform().catch((error) => {
    addDependencies(
      Array.isArray(error.dependencies) ? error.dependencies : [],
    );
    // A stale source digest means Turbopack invoked this transform with a
    // superseded file snapshot. Keep that failure out of the transform cache
    // so the next filesystem invalidation can compile the current input.
    if (
      error.code === 'PMS_STALE_REVISION' &&
      typeof this.cacheable === 'function'
    )
      this.cacheable(false);
    callback(error);
  });
};
