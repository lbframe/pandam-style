/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const DS = '../generated/design.pandamstyle';
const imports = `import { create, token, props, recipes, themes } from '${DS}';\n`;
function page(declarations, selection = 's.a', before = '') {
  return (
    imports +
    before +
    `const s = create({ a: { ${declarations} } });\nexport const result = props(${selection});\n`
  );
}
function namespaces(declarations, selection) {
  return (
    imports +
    `const s = create(${declarations});\nexport const result = props(${selection});\n`
  );
}
function selection(value) {
  return imports + `export const result = props(${value});\n`;
}
module.exports = { DS, imports, page, namespaces, selection };
