/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// Issue #130: the compiler evicts Babel's cached NodePaths of the ASTs it
// compiled, to bound the process-wide path cache. That cache is shared with
// every Babel user in the process, so a compile must never change another
// compilation's paths, bindings or path data, including a compilation
// suspended while the Project Service validates.

const babel = require('@babel/core');
const { openProject } = require('./session-helpers');

const OUTER_SOURCE = 'const foo = 1; console.log(foo);';

/** Runs `outer` as an async Babel plugin around a public `validate()`. */
async function withValidatedProject(run) {
  const fixture = openProject('valid');
  const project = fixture.openPublicSession();
  try {
    const { revision } = await project.initialize();
    const validate = async () => {
      const validated = await project.validate(revision);
      expect(validated.ok).toBe(true);
    };
    return await run(validate);
  } finally {
    await project.close();
    fixture.session.close();
  }
}

function transformOuter(plugin) {
  return babel.transformAsync(OUTER_SOURCE, {
    filename: '/virtual/outer.js',
    babelrc: false,
    configFile: false,
    plugins: [plugin],
  });
}

describe('Babel path cache shared with other compilations (#130)', () => {
  test('a binding held across validate() still owns its reference paths', async () => {
    await withValidatedProject(async (validate) => {
      let held = null;
      let before = null;
      let after = null;
      const result = await transformOuter(() => ({
        async pre(file) {
          held = file.path.scope.getBinding('foo');
          before = held.referencePaths[0];
          await validate();
        },
        visitor: {
          ReferencedIdentifier(p) {
            if (p.node.name !== 'foo') return;
            after = p;
            if (held.referencePaths.includes(p)) {
              p.replaceWithSourceString('42');
            }
          },
        },
      }));
      // Identity as a boolean: a failing NodePath comparison would print
      // both whole trees.
      expect(after != null && after === before).toBe(true);
      expect(result.code).toBe('const foo = 1;\nconsole.log(42);');
    });
  });

  test('a traversal suspended mid-tree resumes on the same paths and data', async () => {
    await withValidatedProject(async (validate) => {
      let resumed = null;
      const result = await transformOuter(() => ({
        async pre(file) {
          // Walk part of the tree, keep its paths and path data, suspend.
          const declaration = file.path.get('body.0');
          declaration.setData('pms-test', 'held');
          const init = declaration.get('declarations.0.init');
          const call = file.path.get('body.1.expression');
          await validate();
          // Resume where the walk stopped: the cache must answer with the
          // same paths, still carrying their data.
          const again = file.path.get('body.0');
          resumed = {
            declaration: again === declaration,
            init: again.get('declarations.0.init') === init,
            call: file.path.get('body.1.expression') === call,
            data: again.getData('pms-test'),
          };
        },
        visitor: {
          VariableDeclaration(p) {
            if (p.getData('pms-test') === 'held') {
              p.get('declarations.0.init').replaceWithSourceString('2');
            }
          },
        },
      }));
      expect(resumed).toEqual({
        declaration: true,
        init: true,
        call: true,
        data: 'held',
      });
      expect(result.code).toBe('const foo = 2;\nconsole.log(foo);');
    });
  });
});
