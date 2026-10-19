/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Incremental JSONL reader for CLI event streams (DESIGN.md section 3).
// It never trusts the stream (section 4.4): it reports syntax anomalies and
// leaves meaning to the adapters. Lines longer than MAX_LINE_BYTES are an
// anomaly, are never buffered whole and are not parsed.

import fs from 'node:fs';

export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Splits a byte stream into lines. A line longer than `maxLine` bytes is
 * never buffered whole: it is reported once as `line-too-long` and skipped
 * up to the next newline, so memory stays bounded whatever the stream.
 */
export function createLineSplitter(
  onLine,
  { maxLine = MAX_LINE_BYTES, onAnomaly = () => {} } = {},
) {
  let pending = '';
  let skipping = false;
  return {
    push(chunk) {
      let text = chunk;
      for (;;) {
        const index = text.indexOf('\n');
        if (index === -1) {
          if (!skipping) {
            pending += text;
            if (Buffer.byteLength(pending) > maxLine) {
              onAnomaly('line-too-long');
              pending = '';
              skipping = true;
            }
          }
          return;
        }
        const head = text.slice(0, index);
        text = text.slice(index + 1);
        if (skipping) skipping = false;
        else {
          const line = pending + head;
          pending = '';
          if (Buffer.byteLength(line) > maxLine) onAnomaly('line-too-long');
          else onLine(line);
        }
      }
    },
    end() {
      if (!skipping && pending.length > 0)
        onLine(pending, { unterminated: true });
      pending = '';
    },
  };
}

/**
 * Bounded raw storage of a stream (section 6.4): the first `headBytes` and
 * the last `tailBytes` are kept, cut at line boundaries so that no partial
 * line (and no partial secret inside a line) is stored, with a marker in
 * between. Memory: the tail buffer only; the head goes to `file` (0600).
 */
export function createBoundedSink(file, { headBytes, tailBytes }) {
  const fd = fs.openSync(file, 'w', 0o600);
  let written = 0;
  let total = 0;
  let headOpen = true;
  let tail = Buffer.alloc(0);
  let pendingHead = Buffer.alloc(0);
  return {
    write(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (headOpen) {
        pendingHead = Buffer.concat([pendingHead, buf]);
        const room = headBytes - written;
        const usable = pendingHead.subarray(0, Math.max(0, room));
        const cut = usable.lastIndexOf(0x0a);
        if (cut !== -1) {
          fs.writeSync(fd, pendingHead.subarray(0, cut + 1));
          written += cut + 1;
          pendingHead = pendingHead.subarray(cut + 1);
        }
        if (written + pendingHead.length <= headBytes) return;
        headOpen = false;
        tail = pendingHead;
        pendingHead = Buffer.alloc(0);
      } else tail = Buffer.concat([tail, buf]);
      if (tail.length > tailBytes * 2)
        tail = tail.subarray(tail.length - tailBytes);
    },
    finish() {
      let truncated = false;
      if (headOpen) fs.writeSync(fd, pendingHead);
      else {
        let t =
          tail.length > tailBytes
            ? tail.subarray(tail.length - tailBytes)
            : tail;
        if (total - written > t.length) {
          truncated = true;
          const nl = t.indexOf(0x0a);
          t = nl === -1 ? Buffer.alloc(0) : t.subarray(nl + 1);
          fs.writeSync(
            fd,
            `[pms-runner: ${total - written - t.length} bytes not stored]\n`,
          );
        }
        fs.writeSync(fd, t);
      }
      fs.closeSync(fd);
      return { bytes: total, truncated };
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
