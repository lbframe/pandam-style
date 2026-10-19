/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CONNECT-only egress proxy (DESIGN.md section 4.3). Allows `host:port` pairs
// of the allowlist, refuses everything else (including plain HTTP), and logs
// one JSON line per request: time, host, decision, bytes each way.
// Usage: connect-proxy.mjs --port 3128 --allow api.anthropic.com:443,...

import net from 'node:net';

export function createProxy({
  allow,
  log = (e) => process.stdout.write(`${JSON.stringify(e)}\n`),
  connect = net.connect,
}) {
  const allowed = new Set(allow);
  return net.createServer((client) => {
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > 16 * 1024) client.destroy();
        return;
      }
      client.off('data', onData);
      const line = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
      const m = /^CONNECT ([A-Za-z0-9.-]+):(\d+) HTTP\/1\.[01]$/.exec(line);
      const target = m ? `${m[1].toLowerCase()}:${m[2]}` : null;
      const entry = {
        at: new Date().toISOString(),
        target: target ?? line.slice(0, 120),
        decision: 'denied',
        up: 0,
        down: 0,
      };
      if (target == null || !allowed.has(target)) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        log(entry);
        return;
      }
      entry.decision = 'allowed';
      const upstream = connect({ host: m[1], port: Number(m[2]) }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      client.on('data', (c) => (entry.up += c.length));
      upstream.on('data', (c) => (entry.down += c.length));
      let logged = false;
      const done = () => {
        if (logged) return;
        logged = true;
        log(entry);
      };
      // Either side closing ends the tunnel, so an abruptly closed client
      // never leaves an open upstream connection or an unlogged entry.
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      upstream.on('close', () => {
        client.destroy();
        done();
      });
      client.on('close', () => {
        upstream.destroy();
        done();
      });
    };
    client.on('data', onData);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1] ?? 3128);
  const allow = (args[args.indexOf('--allow') + 1] ?? '')
    .split(',')
    .filter(Boolean);
  createProxy({ allow }).listen(port, '0.0.0.0');
}
