/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { auditCompute, auditMaterialize, auditRead } from './audit.js';
import { check } from './check.js';
import { diagnosticsAffected, diagnosticsCandidates } from './lists.js';
import { protocolOperations } from './operations.js';
import { recordsRead } from './records.js';
import { sessionStatus } from './status.js';

/**
 * The handlers of the implemented operations. A registry entry is
 * `implemented` exactly when its name is a key here (§3.2.3 rule 2); a
 * planned entry has none, so it cannot run (I2).
 */
export const HANDLERS = Object.freeze({
  'protocol.operations': protocolOperations,
  'session.status': sessionStatus,
  check,
  'diagnostics.candidates': diagnosticsCandidates,
  'diagnostics.affected': diagnosticsAffected,
  'records.read': recordsRead,
  'audit.read': auditRead,
  'audit.compute': auditCompute,
  'audit.materialize': auditMaterialize,
});
