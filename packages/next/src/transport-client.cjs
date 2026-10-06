/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { encode, decode } = require('./transport-codec.cjs');
const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function transportError(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function readConnection(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file))
    throw transportError(
      'PMS_TRANSPORT_PROTOCOL',
      'An absolute coordinator credential file is required.',
    );
  let connection;
  try {
    connection = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw transportError(
      'PMS_COORDINATOR_UNAVAILABLE',
      'Coordinator connection is unavailable; restart the public command and reload.',
    );
  }
  if (
    connection == null ||
    typeof connection !== 'object' ||
    Array.isArray(connection) ||
    connection.protocolVersion !== PROTOCOL_VERSION ||
    typeof connection.supervisorId !== 'string' ||
    typeof connection.authToken !== 'string' ||
    typeof connection.socketPath !== 'string' ||
    !path.isAbsolute(connection.socketPath) ||
    typeof connection.root !== 'string' ||
    !['dev', 'build'].includes(connection.command)
  )
    throw transportError(
      'PMS_TRANSPORT_PROTOCOL',
      'Unsupported coordinator connection.',
    );
  return connection;
}

function verifyResponse(response, connection, requestId, identity) {
  if (
    response == null ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    typeof response.ok !== 'boolean' ||
    response.protocolVersion !== PROTOCOL_VERSION ||
    response.supervisorId !== connection.supervisorId ||
    response.requestId !== requestId ||
    (identity.projectId != null && response.projectId !== identity.projectId) ||
    (identity.sessionId != null && response.sessionId !== identity.sessionId)
  )
    throw transportError(
      'PMS_TRANSPORT_IDENTITY',
      'Coordinator reply belongs to another protocol, request, project, or session.',
    );
  if (!response.ok) {
    const detail = response.error ?? {};
    const error = transportError(
      detail.code ?? 'PMS_COORDINATOR_UNAVAILABLE',
      detail.message ?? 'Coordinator operation failed.',
    );
    error.name = detail.name ?? 'Error';
    if (Array.isArray(detail.diagnostics))
      error.diagnostics = detail.diagnostics;
    if (detail.metadata != null) {
      let metadata;
      try {
        metadata = decode(detail.metadata);
      } catch {
        throw transportError(
          'PMS_TRANSPORT_PROTOCOL',
          'Invalid coordinator error metadata encoding.',
        );
      }
      if (
        metadata == null ||
        typeof metadata !== 'object' ||
        Array.isArray(metadata) ||
        (metadata.details != null &&
          (typeof metadata.details !== 'object' ||
            Array.isArray(metadata.details))) ||
        !Array.isArray(metadata.dependencies) ||
        metadata.dependencies.some((file) => typeof file !== 'string')
      )
        throw transportError(
          'PMS_TRANSPORT_PROTOCOL',
          'Invalid coordinator error metadata shape.',
        );
      error.details = metadata.details;
      error.dependencies = metadata.dependencies;
    }
    throw error;
  }
  try {
    return decode(response.data);
  } catch {
    throw transportError(
      'PMS_TRANSPORT_PROTOCOL',
      'Invalid coordinator reply encoding.',
    );
  }
}

function request(
  file,
  method,
  payload = {},
  identity = {},
  { timeoutMs = 30000 } = {},
) {
  const connection = readConnection(file);
  const requestId = randomUUID();
  const message =
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      supervisorId: connection.supervisorId,
      authToken: connection.authToken,
      requestId,
      method,
      ...identity,
      payload: encode(payload),
    }) + '\n';
  if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES)
    throw transportError(
      'PMS_TRANSPORT_PROTOCOL',
      'Coordinator request exceeds the wire bound.',
    );
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    // This rejects unavailable IO. It never authorizes semantic publication.
    const timer = setTimeout(
      () =>
        finish(
          transportError(
            'PMS_COORDINATOR_UNAVAILABLE',
            'Coordinator request timed out; restart and reload.',
          ),
        ),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(message));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES)
        return finish(
          transportError(
            'PMS_TRANSPORT_PROTOCOL',
            'Coordinator reply exceeds the wire bound.',
          ),
        );
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      try {
        finish(
          null,
          verifyResponse(
            JSON.parse(buffer.slice(0, end)),
            connection,
            requestId,
            identity,
          ),
        );
      } catch (error) {
        finish(error);
      }
    });
    socket.once('error', () =>
      finish(
        transportError(
          'PMS_COORDINATOR_UNAVAILABLE',
          'Coordinator connection failed; restart and reload.',
        ),
      ),
    );
    socket.once('close', () => {
      if (!settled)
        finish(
          transportError(
            'PMS_COORDINATOR_UNAVAILABLE',
            'Coordinator closed before replying; reload against a new session.',
          ),
        );
    });
  });
}

function subscribe(file, identity, listener) {
  const connection = readConnection(file);
  const requestId = randomUUID();
  const socket = net.createConnection(connection.socketPath);
  let buffer = '';
  let acknowledged = false;
  socket.setEncoding('utf8');
  socket.unref();
  socket.once('connect', () =>
    socket.write(
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        supervisorId: connection.supervisorId,
        authToken: connection.authToken,
        requestId,
        method: 'subscribe',
        ...identity,
        payload: encode({}),
      }) + '\n',
    ),
  );
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return socket.destroy();
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const response = JSON.parse(line);
        const event = verifyResponse(response, connection, requestId, identity);
        if (!acknowledged) {
          acknowledged = true;
          continue;
        }
        listener(event);
      } catch {
        socket.destroy();
        return;
      }
    }
  });
  socket.on('error', () => socket.destroy());
  return () => socket.destroy();
}

module.exports = {
  request,
  subscribe,
  readConnection,
  transportError,
  PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
};
