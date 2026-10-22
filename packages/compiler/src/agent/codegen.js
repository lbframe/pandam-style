/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { envelopeSchema } from './registry.js';
import { oneOfDiscriminator } from './schema.js';

/**
 * AG-01.1 type generation. Renders the registry schemas, and nothing else, as
 * TypeScript: every keyword of the subset has one rendering (§3.3). The output
 * is committed as `generated/operations.d.ts` and byte-compared by the parity
 * test. Types never grant validity: the compiler validates every request.
 */

const HEADER = `// Generated from the AG-01.1 operation registry by
// packages/compiler/src/agent/codegen.js. Do not edit: regenerate with
// PMS_UPDATE_AGENT_TYPES=1 and the agent contract suite.
`;

function typeName(operation, suffix) {
  return (
    operation
      .split(/[.-]/)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join('') + suffix
  );
}

function literal(value) {
  return JSON.stringify(value);
}

function indent(text, depth) {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : '  '.repeat(depth) + line))
    .join('\n');
}

export function renderType(schema, depth = 0) {
  if (schema.oneOf != null) {
    // The discriminator is the branch's own `const`; nothing else is implied.
    oneOfDiscriminator(schema);
    return schema.oneOf.map((branch) => renderType(branch, depth)).join(' | ');
  }
  if ('const' in schema) return literal(schema.const);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.map((type) => renderOne(schema, type, depth)).join(' | ');
}

function renderOne(schema, type, depth) {
  switch (type) {
    case 'object': {
      if (schema.format === 'record') return 'AgentRecord';
      const entries = Object.entries(schema.properties ?? {});
      if (entries.length === 0) return 'Record<string, never>';
      const required = new Set(schema.required ?? []);
      const lines = entries.map(([name, child]) => {
        const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : literal(name);
        const optional = required.has(name) ? '' : '?';
        return `  readonly ${key}${optional}: ${indent(renderType(child, depth + 1), 1)};`;
      });
      return `{\n${lines.join('\n')}\n}`;
    }
    case 'array': {
      const item = renderType(schema.items, depth);
      return item.includes(' ') || item.includes('\n')
        ? `ReadonlyArray<${item}>`
        : `readonly ${item}[]`;
    }
    case 'string':
      return schema.enum == null
        ? 'string'
        : schema.enum.map((value) => literal(value)).join(' | ');
    case 'integer':
      return 'number';
    default:
      return type;
  }
}

export function generateOperationTypes(registry) {
  const out = [HEADER];
  out.push(
    '/** A list record: a v1 diagnostic, candidate, affected entry or description, never reshaped. */',
    'export type AgentRecord = { readonly [key: string]: unknown };',
    '',
  );
  for (const entry of registry.entries) {
    out.push(
      `/** \`${entry.name}\` (${entry.status}, ${entry.owner}). */`,
      `export type ${typeName(entry.name, 'Input')} = ${renderType(entry.input)};`,
      `export type ${typeName(entry.name, 'Output')} = ${renderType(entry.output)};`,
      '',
    );
  }
  out.push('/** The input type of every operation, by name. */');
  out.push('export interface OperationInputs {');
  for (const entry of registry.entries)
    out.push(
      `  readonly ${literal(entry.name)}: ${typeName(entry.name, 'Input')};`,
    );
  out.push('}', '');
  out.push('/** The result type of every implemented operation, by name. */');
  out.push('export interface OperationResults {');
  for (const entry of registry.entries) {
    if (entry.status === 'implemented')
      out.push(
        `  readonly ${literal(entry.name)}: ${typeName(entry.name, 'Output')};`,
      );
  }
  out.push('}', '');
  out.push(
    '/** A request. `input` is checked by the compiler, whatever its static type. */',
    'export type AgentRequest = {',
    '  [N in keyof OperationInputs]: {',
    "    readonly protocol?: 'pandamstyle-agent';",
    '    readonly protocolVersion: 1;',
    '    readonly operation: N;',
    '    readonly requestId?: string;',
    "    readonly view?: 'compact' | 'detail';",
    '    readonly maxResponseBytes?: number;',
    '    readonly input?: OperationInputs[N];',
    '  };',
    '}[keyof OperationInputs];',
    '',
  );
  const frame = envelopeSchema(
    {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    registry.names,
  );
  const { result, ...frameProperties } = frame.properties;
  void result;
  const frameSchema = {
    ...frame,
    properties: frameProperties,
    required: frame.required.filter((name) => name !== 'result'),
  };
  out.push(
    '/** The response frame shared by every operation. */',
    `export type AgentEnvelopeFrame = ${renderType(frameSchema)};`,
    '',
    '/** A response; `result` is null whenever the operation produced none. */',
    'export type AgentEnvelope<R> = AgentEnvelopeFrame & { readonly result: R | null };',
    '',
    'export type AgentResponse<N extends keyof OperationResults> = AgentEnvelope<',
    '  OperationResults[N]',
    '>;',
    '',
  );
  return out.join('\n');
}
