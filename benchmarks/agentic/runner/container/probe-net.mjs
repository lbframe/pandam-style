/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Isolation self-test network probe: TCP connects, DNS lookups and an HTTP
// CONNECT through a proxy. Prints one JSON object.
// Usage: probe-net.mjs '{"tcp":["h:p"],"dns":["name"],"connect":{"proxy":"h:p","target":"h:p"}}'

import net from 'node:net';
import dns from 'node:dns/promises';

const spec = JSON.parse(process.argv[2]);
const split = (t) => {
  const i = t.lastIndexOf(':');
  return [t.slice(0, i).replace(/^\[|\]$/g, ''), Number(t.slice(i + 1))];
};
const tcp = (t) =>
  new Promise((res) => {
    const [host, port] = split(t);
    let s;
    try {
      s = net.connect({ host, port, timeout: 3000 });
    } catch (e) {
      res(e.code ?? 'ERROR');
      return;
    }
    s.on('connect', () => {
      s.destroy();
      res('CONNECTED');
    });
    s.on('timeout', () => {
      s.destroy();
      res('TIMEOUT');
    });
    s.on('error', (e) => res(e.code ?? 'ERROR'));
  });
const connectVia = ({ proxy, target }) =>
  new Promise((res) => {
    const [host, port] = split(proxy);
    const s = net.connect({ host, port, timeout: 4000 }, () =>
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let data = '';
    s.on('data', (c) => {
      data += c;
      if (data.includes('\r\n')) {
        s.destroy();
        res(data.split('\r\n')[0]);
      }
    });
    s.on('timeout', () => {
      s.destroy();
      res('TIMEOUT');
    });
    s.on('error', (e) => res(e.code ?? 'ERROR'));
    s.on('close', () => res(data ? data.split('\r\n')[0] : 'CLOSED'));
  });

async function main() {
  const out = { tcp: {}, dns: {}, connect: {} };
  for (const t of spec.tcp ?? []) out.tcp[t] = await tcp(t);
  for (const h of spec.dns ?? []) {
    try {
      out.dns[h] = (await dns.lookup(h)).address;
    } catch (e) {
      out.dns[h] = e.code;
    }
  }
  for (const c of spec.connect ?? [])
    out.connect[`${c.proxy}->${c.target}`] = await connectVia(c);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main();
