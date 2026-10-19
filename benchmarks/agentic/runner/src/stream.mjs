/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Incremental JSONL reader for CLI event streams (DESIGN.md section 3).
// It never trusts the stream (section 4.4): it reports syntax anomalies and
// leaves meaning to the adapters. Lines longer than MAX_LINE_BYTES are an
// anomaly and are not parsed.

export const MAX_LINE_BYTES = 8 * 1024 * 1024;

export function createLineSplitter(onLine) {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        onLine(line);
      }
    },
    end() {
      if (pending.length > 0) onLine(pending, { unterminated: true });
      pending = '';
    },
  };
}

/** Parses one line; returns `{ event }` or `{ anomaly }` or `{ skip }`. */
export function parseLine(line, { unterminated = false } = {}) {
  if (line.trim() === '') return { skip: true };
  if (Buffer.byteLength(line) > MAX_LINE_BYTES)
    return { anomaly: 'line-too-long' };
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return {
      anomaly: unterminated ? 'truncated-final-line' : 'invalid-json',
    };
  }
  if (event === null || typeof event !== 'object' || Array.isArray(event))
    return { anomaly: 'non-object-event' };
  if (typeof event.type !== 'string') return { anomaly: 'event-without-type' };
  return { event };
}
