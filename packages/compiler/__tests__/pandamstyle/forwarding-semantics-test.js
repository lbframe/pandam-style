/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();
const {
  cases,
  runCase,
} = require('../../../../tools/pms/forwarding-semantic-oracle');
const babel = require('@babel/core');
const fs = require('fs');
const { openProject } = require('./session-helpers');
const {
  createUsageContext,
  readModuleFacts,
  resolvePmsAccess,
} = require('../../../../.pms-test-support/compiler-inspection.cjs');

describe('PandamStyle independent forwarding semantic oracle', () => {
  test.each(cases.map((fixture) => [fixture.name, fixture]))(
    '%s: fresh and persistent revisions match intended semantics',
    (name, fixture) => {
      for (const row of runCase(fixture)) {
        expect({ fixture: row.fixture, actual: row.freshActual }).toEqual({
          fixture: row.fixture,
          actual: row.expected,
        });
        expect({ fixture: row.fixture, actual: row.incrementalActual }).toEqual(
          { fixture: row.fixture, actual: row.expected },
        );
        expect(row.freshEqualsIncremental).toBe(true);
        expect(row.viewDifferences).toEqual([]);
      }
    },
  );
});

describe('Babel binding identity at forwarded API access', () => {
  test('the real generated export contract contains exactly six compiler APIs and two metadata/marker exports', () => {
    const h = openProject('valid');
    let info;
    h.full({
      onStage: ({ session }) => {
        info = session._withGraphContext(() =>
          h.compiler.resolveDesignSystemModule(
            h.src('src/page.tsx'),
            '../generated/design.pandamstyle',
          ),
        );
      },
    });
    expect(info.exports.slice().sort()).toEqual([
      '__pandamstyle',
      'create',
      'manifest',
      'patterns',
      'props',
      'recipes',
      'themes',
      'token',
    ]);
    expect(h.compiler.REQUIRED_HELPERS.slice().sort()).toEqual([
      'create',
      'patterns',
      'props',
      'recipes',
      'themes',
      'token',
    ]);
    h.session.close();
  });
  function accesses(relay, source) {
    const h = openProject('valid');
    fs.writeFileSync(h.src('src/binding-relay.js'), relay);
    const result = [];
    h.full({
      onStage: ({ session }) =>
        session._withGraphContext(() =>
          babel.transformSync(source, {
            filename: h.src('src/binding-consumer.js'),
            configFile: false,
            babelrc: false,
            plugins: [
              () => ({
                visitor: {
                  Program(program) {
                    const ctx = createUsageContext({
                      filename: h.src('src/binding-consumer.js'),
                    });
                    readModuleFacts(program, ctx);
                    program.traverse({
                      CallExpression(p) {
                        result.push(
                          resolvePmsAccess(p.get('callee'), ctx)?.exportPath ??
                            null,
                        );
                      },
                    });
                  },
                },
              }),
            ],
          }),
        ),
    });
    h.session.close();
    return result;
  }
  test('renamed import and shadowing use distinct Babel bindings', () => {
    expect(
      accesses(
        "export { token as t } from '../generated/design.pandamstyle';",
        "import { t as local } from './binding-relay'; local('spacing.md'); function f(local) { local('spacing.md'); }",
      ),
    ).toEqual([['token'], null]);
  });
  test('namespace aliases translate members and deny missing and metadata members', () => {
    expect(
      accesses(
        "export { token as t, manifest } from '../generated/design.pandamstyle';",
        "import * as ns from './binding-relay'; ns.t('spacing.md'); ns.token('spacing.md'); ns.manifest();",
      ),
    ).toEqual([['token'], null, null]);
  });
  test('local declarations do not inherit provenance from an unrelated import', () => {
    expect(
      accesses(
        "import { token as unused } from '../generated/design.pandamstyle'; const token = () => 1; export { token };",
        "import { token } from './binding-relay'; token('spacing.md');",
      ),
    ).toEqual([null]);
  });
});
