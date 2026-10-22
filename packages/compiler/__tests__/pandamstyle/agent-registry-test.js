/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.1 registry contract (AC1, I7, I12) and schema-generation parity.
 *
 * Every load-time rule is attacked with one mutated entry, on a planned entry
 * and on an implemented one. The schema subset is checked keyword by keyword
 * over every registered schema, and the committed declarations, the runtime
 * validator and `protocol.operations` are compared against the registry.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { compiler, openAgentProject } = require('./agent-helpers');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GENERATED = path.resolve(
  __dirname,
  '../../src/agent/generated/operations.d.ts',
);

const {
  createRegistry,
  compileSchema,
  validateSchema,
  maxJsonBytes,
  REGISTRY,
  REGISTRY_ENTRIES,
  AGENT_HANDLERS,
  GRANT_EFFECTS,
  PRECONDITIONS,
  universalErrors,
  WORKSPACE_OPERATIONS,
} = compiler;

const clone = (value) => JSON.parse(JSON.stringify(value));
const entriesWith = (name, mutate) =>
  REGISTRY_ENTRIES.map((entry) => {
    const copy = clone(entry);
    if (entry.name === name) mutate(copy);
    return copy;
  });
const effectKey = (effect) =>
  effect.detail == null ? effect.kind : `${effect.kind}:${effect.detail}`;

describe('AG-01.1 registry load-time rules (AC1, I12)', () => {
  test('the shipped registry loads and covers #8 operation list', () => {
    expect(() => createRegistry(clone(REGISTRY_ENTRIES))).not.toThrow();
    const names = REGISTRY.names;
    for (const name of [
      'discover',
      'query',
      'describe',
      'context',
      'check',
      'repair.propose',
      'repair.apply',
      'extend.propose',
      'extend.apply',
      'impact',
      'publish',
      'session.open',
      'session.attach',
      'session.close',
      'session.status',
      'session.apply-changes',
      'install.plan',
      'install.apply',
      'audit.read',
      'audit.compute',
      'audit.materialize',
      'migration.plan',
      'migration.apply',
      'measurement.collect',
    ])
      expect(names).toContain(name);
    expect(
      REGISTRY.entries
        .filter((entry) => entry.status === 'implemented')
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(Object.keys(AGENT_HANDLERS).sort());
  });

  // One mutation per rule of §3.2.3, applied to a planned and to an
  // implemented entry alike.
  const MUTATIONS = {
    'rule 1: unknown entry field': (entry) => {
      entry.role = 'host';
    },
    'rule 1: closed schema keyword (pattern)': (entry) => {
      entry.input.properties.rev = { type: 'string', pattern: '.*' };
    },
    'rule 1: closed effect kind': (entry) => {
      entry.effects.push({ kind: 'reads-network' });
    },
    'rule 1: closed effect detail': (entry) => {
      entry.effects.push({ kind: 'session-state', detail: 'anything' });
    },
    'rule 1: closed grant': (entry) => {
      entry.requires.grant = 'admin';
    },
    'rule 1: closed error outcome': (entry) => {
      entry.errors.push({
        outcome: 'teapot',
        code: 'PMS_INTERNAL',
        reasons: ['x'],
      });
    },
    'rule 1: closed error code': (entry) => {
      entry.errors.push({
        outcome: 'invalid-input',
        code: 'PMS_MADE_UP',
        reasons: ['x'],
      });
    },
    'rule 1: closed precondition id': (entry) => {
      entry.preconditions.push({ id: 'feels-right', outcome: 'invalid-input' });
    },
    'rule 1: closed format': (entry) => {
      entry.input.properties.rev = { type: 'string', format: 'email' };
    },
    'rule 2: status disagrees with the handler': (entry) => {
      entry.status = entry.status === 'planned' ? 'implemented' : 'planned';
    },
    'rule 3: effect outside the grant': (entry) => {
      entry.effects.push({ kind: 'executes-config' });
    },
    'rule 3: stages-audit is allowed by no grant': (entry) => {
      entry.effects.push({ kind: 'session-state', detail: 'stages-audit' });
    },
    'rule 3: empty effects': (entry) => {
      entry.effects = [];
    },
    'rule 4: open input object': (entry) => {
      entry.input.additionalProperties = true;
    },
    'rule 4: nested open object': (entry) => {
      delete entry.input.properties.rev.additionalProperties;
    },
    'rule 4: unbounded string': (entry) => {
      entry.output.properties.extra = { type: 'string' };
    },
    'rule 4: unbounded array': (entry) => {
      entry.input.properties.extra = {
        type: 'array',
        items: { type: 'integer' },
      };
    },
    'rule 4: revision not bound': (entry) => {
      entry.input.required = entry.input.required.filter(
        (name) => name !== 'rev',
      );
    },
    'rule 4: record outside the output': (entry) => {
      entry.input.properties.extra = {
        type: 'array',
        maxItems: 1,
        items: { type: 'object', format: 'record' },
      };
    },
    'rule 5: universal contract missing': (entry) => {
      entry.errors = entry.errors.filter(
        (error) => error.outcome !== 'denied-access',
      );
    },
    'rule 5: precondition without a contract': (entry) => {
      entry.preconditions.push({
        id: 'revision-validated',
        outcome: 'invalid-input',
      });
    },
    'rule 5: non-kebab reason': (entry) => {
      entry.errors[0].reasons = ['Not Closed'];
    },
    'rule 7: a grant list': (entry) => {
      entry.requires.grant = ['consult', 'publish'];
    },
  };

  for (const target of ['publish', 'check']) {
    for (const [label, mutate] of Object.entries(MUTATIONS)) {
      test(`${target}: ${label} fails to load`, () => {
        expect(() => createRegistry(entriesWith(target, mutate))).toThrow(
          /pandamstyle agent (registry|schema)/,
        );
      });
    }
  }

  test('rule 5: a write effect needs its own contract (planned)', () => {
    expect(() =>
      createRegistry(
        entriesWith('publish', (entry) => {
          for (const error of entry.errors)
            error.covers = (error.covers ?? []).filter(
              (cover) => cover !== 'effect:writes-generated',
            );
        }),
      ),
    ).toThrow(/writes-generated has no error contract/);
  });

  test('rule 6: a write, execution or lifecycle effect is never retried blindly', () => {
    for (const name of [
      'publish',
      'session.open',
      'repair.apply',
      'session.close',
    ]) {
      expect(() =>
        createRegistry(
          entriesWith(name, (entry) => {
            entry.retry = { idempotent: true, policy: 'safe' };
          }),
        ),
      ).toThrow(/never retried/);
    }
  });

  test('rule 6: an implemented consultation may not declare a revoking effect', () => {
    expect(() =>
      createRegistry(
        entriesWith('check', (entry) => {
          entry.effects.push({
            kind: 'session-state',
            detail: 'revokes-publication-tickets',
          });
        }),
      ),
    ).toThrow(/outside grant consult/);
  });

  test('a handler for no entry, and a duplicate name, fail to load', () => {
    expect(() =>
      createRegistry(clone(REGISTRY_ENTRIES), {
        ...AGENT_HANDLERS,
        'ghost.op': async () => ({}),
      }),
    ).toThrow(/a handler exists for no registered entry/);
    const entries = clone(REGISTRY_ENTRIES);
    expect(() => createRegistry([...entries, clone(entries[2])])).toThrow(
      /duplicate name/,
    );
  });
});

describe('AG-01.1 every registered entry (table, AC1)', () => {
  for (const entry of REGISTRY_ENTRIES) {
    test(`${entry.name} (${entry.status})`, () => {
      expect(() => compileSchema(entry.input, 'input')).not.toThrow();
      expect(() => compileSchema(entry.output, 'output')).not.toThrow();
      expect(entry.input.type).toBe('object');
      expect(entry.input.additionalProperties).toBe(false);
      if (entry.name !== 'session.status')
        expect(Object.keys(entry.input.properties).length).toBeGreaterThan(0);
      if (entry.requires.revision === 'current')
        expect(
          entry.input.required.includes('rev') ||
            entry.input.required.includes('baseRevision'),
        ).toBe(true);
      const allowed = GRANT_EFFECTS[entry.requires.grant ?? 'none'];
      expect(entry.effects.length).toBeGreaterThan(0);
      for (const effect of entry.effects)
        expect(allowed).toContain(effectKey(effect));
      for (const required of universalErrors(entry))
        expect(
          entry.errors.some(
            (error) =>
              error.outcome === required.outcome &&
              error.code === required.code &&
              required.reasons.every((reason) =>
                error.reasons.includes(reason),
              ),
          ),
        ).toBe(true);
      const covered = entry.errors.flatMap((error) => error.covers ?? []);
      for (const precondition of entry.preconditions) {
        expect(PRECONDITIONS[precondition.id]).toBe(precondition.outcome);
        expect(covered).toContain(`precondition:${precondition.id}`);
      }
      for (const effect of entry.effects) {
        if (
          [
            'writes-generated',
            'writes-audit',
            'writes-sources',
            'executes-config',
            'session-lifecycle',
          ].includes(effect.kind)
        )
          expect(covered).toContain(`effect:${effect.kind}`);
      }
      // I3: a consultation declares no write, execution, scheduling or
      // ticket effect.
      if (entry.requires.grant == null || entry.requires.grant === 'consult') {
        for (const effect of entry.effects) {
          expect([
            'writes-generated',
            'writes-audit',
            'writes-sources',
            'executes-config',
            'schedules',
            'session-lifecycle',
          ]).not.toContain(effect.kind);
          expect(effect.detail).not.toBe('revokes-publication-tickets');
          expect(effect.detail).not.toBe('advances-revision');
        }
      }
      expect(entry.status === 'implemented').toBe(
        Object.hasOwn(AGENT_HANDLERS, entry.name),
      );
    });
  }
});

// --------------------------------------------------------- the subset ----

function formatSample(format) {
  switch (format) {
    case 'request-id':
      return 'r-1';
    case 'project-relative-path':
      return 'src/page.js';
    case 'sha256':
      return 'a'.repeat(64);
    case 'hex-digest':
      return 'ac409b6b43e77a38';
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    case 'chunk':
      return '{"a":1}';
    default:
      throw new Error(format);
  }
}

/** A valid sample of `schema`: every declared property present. */
function sampleOf(schema) {
  if (schema.oneOf != null) return sampleOf(schema.oneOf[0]);
  if ('const' in schema) return schema.const;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((candidate) => candidate !== 'null') ?? 'null';
  switch (type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([name, child]) => [
          name,
          sampleOf(child),
        ]),
      );
    case 'array':
      return schema.maxItems > 0 ? [sampleOf(schema.items)] : [];
    case 'string':
      if (schema.enum != null) return schema.enum[0];
      if (schema.format != null) return formatSample(schema.format);
      return 'a'.repeat(Math.max(schema.minLength ?? 0, 1));
    case 'integer':
      return schema.minimum ?? 0;
    case 'boolean':
      return true;
    default:
      return null;
  }
}

/** One mutated sample per keyword at every node: each must fail. */
function mutationsOf(schema) {
  const out = [];
  const sample = sampleOf(schema);
  if (schema.oneOf != null) {
    const branch = schema.oneOf[0];
    const discriminator = Object.keys(branch.properties).find(
      (name) => 'const' in branch.properties[name],
    );
    out.push({
      keyword: 'oneOf',
      value: { ...sample, [discriminator]: '~none~' },
    });
    for (const mutation of mutationsOf(branch))
      if (mutation.keyword !== 'const' || mutation.path?.[0] !== discriminator)
        out.push(mutation);
    return out;
  }
  if ('const' in schema) {
    out.push({
      keyword: 'const',
      value:
        typeof schema.const === 'number'
          ? schema.const + 1
          : `${schema.const}~`,
    });
    return out;
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const wrong = types.includes('boolean')
    ? 'not-a-boolean'
    : types.includes('string')
      ? 42
      : true;
  out.push({ keyword: 'type', value: wrong });
  if (types.includes('object') && schema.format !== 'record') {
    out.push({
      keyword: 'additionalProperties',
      value: { ...sample, zzUnknown: 1 },
    });
    for (const name of schema.required ?? []) {
      const { [name]: _dropped, ...rest } = sample;
      void _dropped;
      out.push({ keyword: 'required', value: rest });
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      for (const mutation of mutationsOf(child))
        out.push({
          keyword: mutation.keyword,
          path: [name, ...(mutation.path ?? [])],
          value: { ...sample, [name]: mutation.value },
        });
    }
  }
  if (types.includes('array')) {
    out.push({
      keyword: 'maxItems',
      value: Array.from({ length: schema.maxItems + 1 }, () =>
        sampleOf(schema.items),
      ),
    });
    if (schema.maxItems > 0)
      for (const mutation of mutationsOf(schema.items))
        out.push({ keyword: mutation.keyword, value: [mutation.value] });
  }
  if (types.includes('string')) {
    if (schema.enum != null)
      out.push({ keyword: 'enum', value: '~not-in-enum~' });
    if (schema.format != null)
      out.push({ keyword: 'format', value: 'NOT VALID/../' });
    if (schema.maxLength != null)
      out.push({
        keyword: 'maxLength',
        value: 'a'.repeat(schema.maxLength + 1),
      });
    if (schema.minLength != null && schema.minLength > 0)
      out.push({ keyword: 'minLength', value: '' });
  }
  if (types.includes('integer')) {
    if (schema.minimum != null)
      out.push({ keyword: 'minimum', value: schema.minimum - 1 });
    if (schema.maximum != null && schema.maximum < Number.MAX_SAFE_INTEGER)
      out.push({ keyword: 'maximum', value: schema.maximum + 1 });
    out.push({ keyword: 'type', value: 1.5 });
  }
  return out;
}

describe('AG-01.1 schema subset (D2)', () => {
  for (const entry of REGISTRY_ENTRIES) {
    test(`${entry.name}: a sample passes, every keyword mutation fails`, () => {
      const sample = sampleOf(entry.input);
      expect(validateSchema(entry.input, sample)).toBeNull();
      const mutations = mutationsOf(entry.input);
      expect(mutations.length).toBeGreaterThan(0);
      for (const mutation of mutations) {
        const failure = validateSchema(entry.input, mutation.value);
        expect({ keyword: mutation.keyword, failure }).toEqual({
          keyword: mutation.keyword,
          failure: expect.objectContaining({ keyword: expect.any(String) }),
        });
      }
    });
  }

  test('failure paths name declared properties and indexes only', () => {
    const entry = REGISTRY.byName['diagnostics.candidates'];
    const failure = validateSchema(entry.input, {
      rev: { projectId: 'p', sessionId: 's', revisionId: 1 },
      domain: { kind: 'category', category: 'x', 'injected text': true },
    });
    expect(failure).toEqual({
      path: ['domain'],
      keyword: 'additionalProperties',
    });
  });

  test('maxLength counts JSON-serialized UTF-8 bytes', () => {
    const schema = { type: 'string', maxLength: 6 };
    expect(validateSchema(schema, 'aaaaaa')).toBeNull();
    expect(validateSchema(schema, 'ééé')).toBeNull();
    expect(validateSchema(schema, 'éééé')).not.toBeNull();
    expect(validateSchema(schema, '\u0001')).toBeNull();
    expect(validateSchema(schema, '\u0001\u0001')).not.toBeNull();
  });

  test('maxJsonBytes bounds every sample of every output schema', () => {
    for (const entry of REGISTRY_ENTRIES) {
      const bound = maxJsonBytes(entry.output);
      const sample = sampleOf(entry.output);
      expect(Buffer.byteLength(JSON.stringify(sample))).toBeLessThanOrEqual(
        bound,
      );
    }
  });
});

// -------------------------------------------------------------- parity ----

/** The registry's declarations, formatted by the repository's Prettier. */
function formattedTypes() {
  return execFileSync(
    path.join(REPO_ROOT, 'node_modules/.bin/prettier'),
    ['--stdin-filepath', GENERATED],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: compiler.generateOperationTypes(REGISTRY),
    },
  );
}

describe('AG-01.1 schema-generation parity', () => {
  test('the committed operations.d.ts is the registry, regenerated', () => {
    const generated = formattedTypes();
    if (process.env.PMS_UPDATE_AGENT_TYPES === '1')
      fs.writeFileSync(GENERATED, generated);
    expect(fs.readFileSync(GENERATED, 'utf8')).toBe(generated);
  });

  test('protocol.operations (detail) equals the registry schemas', async () => {
    const project = await openAgentProject('valid');
    try {
      const response = await project.dispatch(
        'protocol.operations',
        { page: { offset: 0, limit: 256 } },
        { view: 'detail' },
      );
      expect(response.outcome).toBe('success');
      const described = response.result.page.records;
      expect(described.map((entry) => entry.name)).toEqual(REGISTRY.names);
      for (const entry of REGISTRY_ENTRIES) {
        const record = described.find((item) => item.name === entry.name);
        expect(record.input).toEqual(entry.input);
        expect(record.output).toEqual(entry.output);
        expect(record.effects).toEqual(entry.effects);
        expect(record.errors).toEqual(
          entry.errors.map(({ outcome, code, reasons }) => ({
            outcome,
            code,
            reasons,
          })),
        );
      }
      expect(response.result).toEqual(
        expect.objectContaining({
          granted: ['consult'],
          protocolVersion: 1,
        }),
      );
      expect(
        Object.fromEntries(
          described.map((item) => [item.name, item.availability]),
        ),
      ).toEqual(
        Object.fromEntries(
          REGISTRY_ENTRIES.map((entry) => [
            entry.name,
            entry.status === 'planned'
              ? 'planned'
              : // AG-02.1: a host binding serves no workspace operation.
                WORKSPACE_OPERATIONS.includes(entry.name)
                ? 'unsupported'
                : entry.requires.grant == null ||
                    entry.requires.grant === 'consult'
                  ? 'available'
                  : 'denied',
          ]),
        ),
      );
      const compact = await project.dispatch('protocol.operations', {});
      expect(compact.result.page.records[0].input).toBeUndefined();
      expect(compact.result.page.total).toBe(REGISTRY.names.length);
    } finally {
      await project.close();
    }
  });

  test('the declarations compile, reject unknown fields and wrong enums, and accept a request the compiler refuses', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-agent-types-'));
    try {
      fs.copyFileSync(GENERATED, path.join(root, 'operations.d.ts'));
      const rev = "{ projectId: 'p', sessionId: 's', revisionId: 1 }";
      fs.writeFileSync(
        path.join(root, 'positive.ts'),
        [
          "import type { AgentRequest, CheckInput, AgentResponse } from './operations';",
          `const a: AgentRequest = { protocolVersion: 1, operation: 'check', input: { rev: ${rev} } };`,
          `const b: AgentRequest = { protocolVersion: 1, operation: 'diagnostics.candidates', view: 'detail', input: { rev: ${rev}, domain: { kind: 'category-index', index: 0 } } };`,
          "const c: AgentRequest = { protocolVersion: 1, operation: 'records.read', input: { rev: null, address: { kind: 'bootstrap', index: 0 }, page: { offset: 0, limit: 1 } } };",
          "const d: AgentRequest = { protocolVersion: 1, operation: 'protocol.operations' };",
          // Statically valid, refused by the compiler at runtime: revisionId 0
          // and a stale identity are values, not types (AC5).
          "const e: CheckInput = { rev: { projectId: 'p', sessionId: 's', revisionId: 0 } };",
          "declare const r: AgentResponse<'check'>;",
          'const ok: boolean | undefined = r.result?.document?.ok;',
          'void [a, b, c, d, e, ok];',
          '// @ts-expect-error unknown field',
          `const f: AgentRequest = { protocolVersion: 1, operation: 'check', input: { rev: ${rev}, role: 'host' } };`,
          '// @ts-expect-error unknown operation',
          "const g: AgentRequest = { protocolVersion: 1, operation: 'admin' };",
          '// @ts-expect-error wrong enum',
          `const h: AgentRequest = { protocolVersion: 1, operation: 'check', view: 'full', input: { rev: ${rev} } };`,
          '// @ts-expect-error wrong discriminator',
          "const i: AgentRequest = { protocolVersion: 1, operation: 'records.read', input: { rev: null, address: { kind: 'token', index: 0 }, page: { offset: 0, limit: 1 } } };",
          'void [f, g, h, i];',
          '',
        ].join('\n'),
      );
      execFileSync(
        path.join(REPO_ROOT, 'node_modules/.bin/tsc'),
        [
          '--noEmit',
          '--strict',
          '--target',
          'ES2022',
          '--module',
          'ESNext',
          '--moduleResolution',
          'node',
          path.join(root, 'positive.ts'),
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
