/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Runner images (DESIGN.md sections 3.7 and 4.2). The harness image carries
// an execute-only Node (non-dumpable processes, Appendix A P2) and the
// container scripts; the agent image adds the pinned CLIs (execute-only), git
// and the fixtures' package managers. Images are identified by image id.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { docker } from './docker.mjs';
import { RUNNER_ROOT } from './util.mjs';

// Observed locally (Appendix A, P2); pulled by digest when absent.
export const BASE_IMAGE =
  'node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392';

function context(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-image-'));
  for (const [name, src] of Object.entries(files)) {
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.statSync(src).isDirectory())
      fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
    else fs.copyFileSync(src, dest);
  }
  return dir;
}

function build(tag, dockerfile, files) {
  const dir = context(files);
  try {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), dockerfile);
    const r = docker(['build', '-q', '-t', tag, dir], {
      timeout: 30 * 60 * 1000,
    });
    if (r.status !== 0)
      throw new Error(`docker build ${tag} failed: ${r.stderr.slice(-2000)}`);
    return docker(['image', 'inspect', '-f', '{{.Id}}', tag]).stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Harness image. `nodeDir` is an extracted Node distribution (the verified
 * store's Node 22.22.0 for real runs); without it the base image's own Node is
 * reused, which is enough for the isolation self-test only.
 */
export function buildHarnessImage({
  tag = 'pms-agentic-harness:local',
  nodeDir = null,
} = {}) {
  const files = { container: path.join(RUNNER_ROOT, 'container') };
  if (nodeDir) files.node = nodeDir;
  const dockerfile = [
    `FROM ${BASE_IMAGE}`,
    nodeDir
      ? 'COPY node /opt/node'
      : 'RUN mkdir -p /opt/node/bin && cp /usr/local/bin/node /opt/node/bin/node',
    'RUN rm -rf /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/lib/node_modules /opt/yarn-* \\',
    ' && chown root:root /opt/node/bin/node && chmod 0711 /opt/node/bin/node \\',
    ' && test ! -e /node_modules',
    'COPY container /opt/harness',
    'RUN chmod -R a+rX /opt/harness',
    'ENV PATH=/opt/node/bin:/usr/bin:/bin',
    'ENTRYPOINT []',
    'CMD []',
  ].join('\n');
  return build(tag, `${dockerfile}\n`, files);
}

/**
 * Agent image: harness image plus the pinned CLI binaries (execute-only),
 * git and the package managers of the fixtures (yarn 1.22.22, pnpm 9.15.4).
 */
export function buildAgentImage({
  tag = 'pms-agentic-agent:local',
  harnessTag,
  claudeBinary,
  codexDir,
}) {
  const dockerfile = [
    `FROM ${harnessTag}`,
    'USER root',
    'RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*',
    'COPY claude /opt/cli/claude',
    'COPY codex /opt/cli/codex-dist',
    'RUN cp /opt/cli/codex-dist/bin/codex /opt/cli/codex \\',
    ' && chown -R root:root /opt/cli && chmod 0711 /opt/cli/claude /opt/cli/codex \\',
    ' && find /opt/cli/codex-dist -type f -perm -u+x -exec chmod 0711 {} +',
    'ENV COREPACK_HOME=/opt/corepack',
    'RUN /opt/node/bin/corepack enable --install-directory /opt/node/bin && /opt/node/bin/corepack prepare yarn@1.22.22 pnpm@9.15.4 --activate && chmod -R a+rX /opt/corepack',
    'ENV COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 DISABLE_AUTOUPDATER=1',
  ].join('\n');
  return build(tag, `${dockerfile}\n`, {
    claude: claudeBinary,
    codex: codexDir,
  });
}
