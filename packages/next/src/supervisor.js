/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import codec from './transport-codec.cjs';
import transport from './transport-client.cjs';

const { encode, decode } = codec;
const { PROTOCOL_VERSION, MAX_MESSAGE_BYTES, transportError } = transport;

export async function resolveInstalledNext(root) {
  const consumerRequire = createRequire(path.join(root, 'package.json'));
  const manifestFile = consumerRequire.resolve('next/package.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (manifest.version !== '16.3.8')
    throw transportError(
      'PMS_UNSUPPORTED_FEATURE',
      `Next ${manifest.version} is outside the exact qualified target 16.3.8.`,
    );
  const entry =
    typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.next;
  if (typeof entry !== 'string')
    throw transportError(
      'PMS_UNSUPPORTED_FEATURE',
      'Installed Next has no public next executable.',
    );
  const binary = path.resolve(path.dirname(manifestFile), entry);
  const relative = path.relative(path.dirname(manifestFile), binary);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw transportError(
      'PMS_UNSUPPORTED_FEATURE',
      'Installed Next executable escapes its package.',
    );
  await fs.access(binary);
  return {
    binary,
    version: manifest.version,
    packageDirectory: await fs.realpath(path.dirname(manifestFile)),
  };
}

export async function createSupervisor(
  inputRoot,
  { command, createOwner } = {},
) {
  const root = await fs.realpath(inputRoot);
  if (!['dev', 'build'].includes(command))
    throw transportError(
      'PMS_UNSUPPORTED_FEATURE',
      'The supervisor supports dev or build with explicit Turbopack.',
    );
  const supervisorId = randomUUID();
  const authToken = randomBytes(32).toString('hex');
  const socketDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pms-next-ipc-'),
  );
  await fs.chmod(socketDirectory, 0o700);
  const socketPath = path.join(socketDirectory, 'coordinator.sock');
  const bootstrapDirectory = path.join(
    root,
    '.pandamstyle-next-host',
    `bootstrap-${supervisorId}`,
  );
  await fs.mkdir(bootstrapDirectory, { recursive: true, mode: 0o700 });
  const credentialFile = path.join(bootstrapDirectory, 'connection.json');
  const connection = {
    protocolVersion: PROTOCOL_VERSION,
    supervisorId,
    authToken,
    socketPath,
    root,
    command,
  };
  let owner;
  let optionsDigest;
  let registerTail = Promise.resolve();
  let productionBoundaryObserved = false;
  let productionCompleted = false;
  let closed = false;
  const sockets = new Set();
  const subscribers = new Map();

  const response = (request, data, error) => ({
    protocolVersion: PROTOCOL_VERSION,
    supervisorId,
    requestId: request.requestId,
    projectId: request.projectId ?? data?.projectId ?? null,
    sessionId: request.sessionId ?? data?.sessionId ?? null,
    ok: error == null,
    ...(error == null
      ? { data: encode(data) }
      : {
          error: {
            name: error.name,
            code:
              error.code ??
              error.diagnostics?.[0]?.code ??
              'PMS_COORDINATOR_UNAVAILABLE',
            message: error.message,
            ...(Array.isArray(error.diagnostics)
              ? { diagnostics: error.diagnostics }
              : {}),
            metadata: encode({
              details: error.details ?? null,
              dependencies: error.dependencies ?? [],
            }),
          },
        }),
  });
  const send = (socket, request, data, error) => {
    if (socket.destroyed) return;
    const bytes = JSON.stringify(response(request, data, error)) + '\n';
    if (Buffer.byteLength(bytes) > MAX_MESSAGE_BYTES) {
      socket.destroy();
      return;
    }
    socket.write(bytes);
  };
  const event = (value) => {
    for (const [socket, request] of subscribers) send(socket, request, value);
  };
  const authorize = (request) => {
    const supplied =
      typeof request.authToken === 'string'
        ? Buffer.from(request.authToken)
        : Buffer.alloc(0);
    const expected = Buffer.from(authToken);
    if (
      closed ||
      request.protocolVersion !== PROTOCOL_VERSION ||
      request.supervisorId !== supervisorId ||
      typeof request.requestId !== 'string' ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw transportError(
        'PMS_TRANSPORT_PROTOCOL',
        'Coordinator authentication or protocol mismatch.',
      );
    if (
      !['register', 'identify'].includes(request.method) &&
      (owner == null ||
        request.projectId !== owner.projectId ||
        request.sessionId !== owner.sessionId)
    )
      throw transportError(
        'PMS_TRANSPORT_IDENTITY',
        'Coordinator request belongs to another project or session; reload after owner restart.',
      );
  };
  const register = (payload) => {
    const queued = registerTail.then(async () => {
      if (closed)
        throw transportError(
          'PMS_COORDINATOR_UNAVAILABLE',
          'Supervisor is closing.',
        );
      if (payload.root !== root || payload.command !== command)
        throw transportError(
          'PMS_TRANSPORT_IDENTITY',
          'CLI and config project/command disagree.',
        );
      const expectedMode = command === 'dev' ? 'semantic-dev' : 'strict';
      if (
        payload.options?.backend !== 'turbopack' ||
        payload.options.publicationMode !== expectedMode
      )
        throw transportError(
          'PMS_UNSUPPORTED_FEATURE',
          `The public ${command} command requires Turbopack publicationMode ${expectedMode}.`,
        );
      const digest = createHash('sha256')
        .update(
          JSON.stringify(
            encode({ options: payload.options, distDir: payload.distDir }),
          ),
        )
        .digest('hex');
      if (owner != null && digest !== optionsDigest)
        throw transportError(
          'PMS_UNSUPPORTED_FEATURE',
          'Config options changed within one supervisor session; restart to accept a new host configuration.',
        );
      if (owner == null) {
        const factory =
          createOwner ?? (await import('./coordinator.js')).createCoordinator;
        owner = await factory(root, payload.options, {
          command,
          distDir: payload.distDir,
          credentialFile,
          onEvent: event,
        });
        optionsDigest = digest;
      }
      return owner.registerDescription();
    });
    registerTail = queued.catch(() => {});
    return queued;
  };
  const dispatch = async (request, socket) => {
    authorize(request);
    let payload;
    try {
      payload = decode(request.payload);
    } catch {
      throw transportError(
        'PMS_TRANSPORT_PROTOCOL',
        'Invalid coordinator payload encoding.',
      );
    }
    if (request.method === 'register') return register(payload);
    if (request.method === 'identify') {
      if (owner == null)
        throw transportError(
          'PMS_INVALID_REVISION',
          'No configuration has registered this coordinator.',
        );
      return owner.registerDescription();
    }
    if (request.method === 'subscribe') {
      subscribers.set(socket, request);
      return {
        subscribed: true,
        projectId: owner.projectId,
        sessionId: owner.sessionId,
      };
    }
    if (request.method === 'transform')
      return owner.transform({
        ...payload,
        projectId: request.projectId,
        sessionId: request.sessionId,
      });
    if (request.method === 'synchronize') {
      await owner.synchronize();
      return owner.registerDescription();
    }
    if (request.method === 'snapshot-stats') return owner.snapshotStats();
    if (request.method === 'status') return owner.registerDescription();
    if (request.method === 'production-complete') {
      if (
        command !== 'build' ||
        typeof payload.projectDir !== 'string' ||
        (await fs.realpath(payload.projectDir)) !== root
      )
        throw transportError(
          'PMS_TRANSPORT_IDENTITY',
          'Production completion must identify the supervised build project.',
        );
      await owner.recordProductionBoundary?.({
        projectDir: root,
        buildId: payload.buildId ?? null,
      });
      productionBoundaryObserved = true;
      return {
        frameworkBoundaryObserved: true,
        projectId: owner.projectId,
        sessionId: owner.sessionId,
      };
    }
    throw transportError(
      'PMS_TRANSPORT_PROTOCOL',
      'Unknown coordinator operation.',
    );
  };
  const server = net.createServer((socket) => {
    if (sockets.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) {
        socket.destroy();
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      handled = true;
      let request;
      try {
        request = JSON.parse(buffer.slice(0, end));
      } catch {
        socket.destroy();
        return;
      }
      if (
        request == null ||
        typeof request !== 'object' ||
        Array.isArray(request)
      ) {
        socket.destroy();
        return;
      }
      dispatch(request, socket).then(
        (data) => {
          send(socket, request, data);
          if (request.method === 'subscribe')
            for (const value of owner.events ?? [])
              send(socket, request, value);
        },
        (error) => send(socket, request, null, error),
      );
    });
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      sockets.delete(socket);
      subscribers.delete(socket);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);
    await fs.writeFile(credentialFile, JSON.stringify(connection) + '\n', {
      mode: 0o600,
    });
  } catch (error) {
    server.close();
    await fs.rm(socketDirectory, { recursive: true, force: true });
    await fs.rm(bootstrapDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    command,
    credentialFile,
    supervisorId,
    get owner() {
      return owner;
    },
    get productionCompleted() {
      return productionCompleted;
    },
    get productionBoundaryObserved() {
      return productionBoundaryObserved;
    },
    async finishSuccessfulProduction({ exitCode, signal = null }) {
      if (
        command !== 'build' ||
        exitCode !== 0 ||
        signal !== null ||
        !productionBoundaryObserved ||
        owner == null
      )
        throw transportError(
          'PMS_INVALID_REVISION',
          'Canonical production publication requires public completion and a successful installed Next process exit.',
        );
      if (productionCompleted) return owner.finishProduction();
      const receipt = await owner.finishProduction();
      productionCompleted = true;
      return receipt;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await registerTail;
      try {
        await owner?.close();
      } finally {
        await fs.rm(bootstrapDirectory, { recursive: true, force: true });
        await fs.rm(socketDirectory, { recursive: true, force: true });
      }
    },
  };
}
