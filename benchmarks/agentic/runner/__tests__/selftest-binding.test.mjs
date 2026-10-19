/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The isolation self-test's host binding (DESIGN.md sections 4.3 and 11):
// only stable routable host addresses are bound, so Docker networks,
// bridges, veths and link-local churn between the self-test and preflight
// never invalidate it, while a change of a routable address still does.
// Deterministic: synthetic interface tables, no Docker, no timing.

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from './helpers.mjs';
import { inSubnet, stableHostAddresses } from '../src/docker.mjs';
import { requireValidSelfTest, selftestBinding } from '../src/selftest.mjs';
import { digestJson, writeJson } from '../src/util.mjs';

const v4 = (address, extra = {}) => ({
  address,
  family: 'IPv4',
  internal: false,
  ...extra,
});
const v6 = (address, extra = {}) => ({
  address,
  family: 'IPv6',
  internal: false,
  ...extra,
});

const HOST = {
  lo: [v4('127.0.0.1', { internal: true }), v6('::1', { internal: true })],
  enp5s0: [
    v4('192.168.1.126'),
    v6('2a01:e0a:a70:2040:aa5e:45ff:fe50:a719'),
    v6('fe80::aa5e:45ff:fe50:a719%enp5s0'),
  ],
  docker0: [v4('172.17.0.1'), v6('fe80::42:1ff:fe2a:1')],
  'br-0a1b2c3d4e5f': [v4('172.20.0.1')],
  veth1a2b3c: [v6('fe80::10b5:a2ff:fec6:bb1d')],
  // A Docker network address on an interface with an unusual name.
  ens9: [v4('172.21.0.1')],
  zt0: [v4('169.254.12.7')],
};
const SUBNETS = ['172.17.0.0/16', '172.20.0.0/16', '172.21.0.0/16'];

test('stable host addresses: routable only, nothing created by Docker or link-local', () => {
  assert.deepEqual(
    stableHostAddresses({ interfaces: HOST, subnets: SUBNETS }),
    ['192.168.1.126', '2a01:e0a:a70:2040:aa5e:45ff:fe50:a719'],
  );
  assert.equal(inSubnet('172.21.0.1', '172.21.0.0/16'), true);
  assert.equal(inSubnet('fe80::1', 'fe80::/10'), true);
  assert.equal(inSubnet('febf::1', 'fe80::/10'), true);
  assert.equal(inSubnet('fec0::1', 'fe80::/10'), false);
  assert.equal(inSubnet('2a01::1', '172.17.0.0/16'), false);
  assert.equal(inSubnet('::ffff:172.17.0.9', '172.17.0.0/16'), false);
});

function facts(interfaces, subnets) {
  return {
    dockerVersion: '29.2.1',
    kernel: '6.8.0',
    hostAddresses: stableHostAddresses({ interfaces, subnets }),
  };
}

const config = {
  kind: 'provider-backed',
  images: {
    agent: 'sha256:a',
    proxy: 'sha256:p',
    grader: 'sha256:g',
    baseDigest: null,
  },
  network: {
    mode: 'per-attempt-internal-isolated-gateway',
    ipv6: false,
    allow: { claude: ['api.anthropic.com:443'] },
  },
  container: {
    cpus: 2,
    memoryBytes: 4e9,
    pidsLimit: 512,
    tmpfsBytes: 1e9,
    workspaceBytesCap: 4e9,
  },
};

function selfTestResult(stateDir, f) {
  const binding = selftestBinding(config, f);
  writeJson(path.join(stateDir, `selftest-${digestJson(binding)}.json`), {
    at: new Date().toISOString(),
    passed: true,
    binding,
    bindingDigest: digestJson(binding),
    checks: [],
  });
}

test('Docker networks, bridges, veths and link-local churn between self-test and preflight keep the binding', () => {
  const stateDir = tmpDir('stb');
  selfTestResult(stateDir, facts(HOST, SUBNETS));
  // A network created (and a container attached) after the self-test.
  const churned = {
    ...HOST,
    'br-ffeeddccbbaa': [v4('172.30.0.1'), v6('fe80::dead:beef')],
    veth9z8y7x: [v6('fe80::80c6:f6ff:fe2b:31fc')],
    enp5s0: [...HOST.enp5s0, v6('fe80::1234:5678%enp5s0')],
  };
  assert.equal(
    requireValidSelfTest({
      stateDir,
      config,
      facts: facts(churned, [...SUBNETS, '172.30.0.0/16']),
    }).passed,
    true,
  );
  // And removed again: a network gone, a veth gone.
  const removed = { ...HOST };
  delete removed['br-0a1b2c3d4e5f'];
  delete removed.veth1a2b3c;
  assert.equal(
    requireValidSelfTest({
      stateDir,
      config,
      facts: facts(removed, ['172.17.0.0/16', '172.21.0.0/16']),
    }).passed,
    true,
  );
});

test('a change of a routable host address still rejects (fail closed)', () => {
  const stateDir = tmpDir('stb2');
  selfTestResult(stateDir, facts(HOST, SUBNETS));
  for (const changed of [
    { ...HOST, enp5s0: [v4('192.168.1.200'), HOST.enp5s0[1]] },
    { ...HOST, enp5s0: [HOST.enp5s0[0]] },
    { ...HOST, wlan0: [v4('10.0.0.7')] },
  ])
    assert.throws(
      () =>
        requireValidSelfTest({
          stateDir,
          config,
          facts: facts(changed, SUBNETS),
        }),
      /no isolation self-test/,
    );
});
