/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const QUALIFIED_CONFIGURATION = 'next-16.3.8-react-19.3.0';

function unsupported(message) {
  const error = new Error(message);
  error.code = 'PMS_UNSUPPORTED_FEATURE';
  return error;
}

/**
 * React Compiler admission is an explicit pin, not a promise across Next or
 * React releases. The capability also depends on Next's public top-level
 * `reactCompiler` option, which is the configuration used by the qualification.
 */
export function assertReactCompilerQualification(
  config,
  qualification,
  installedVersions,
) {
  if (qualification != null && qualification !== QUALIFIED_CONFIGURATION) {
    throw unsupported(
      `Unknown React Compiler qualification "${qualification}". The only candidate is "${QUALIFIED_CONFIGURATION}".`,
    );
  }

  const enabled =
    config.reactCompiler === true ||
    config.experimental?.reactCompiler === true;
  if (!enabled) {
    if (qualification != null) {
      throw unsupported(
        `React Compiler qualification "${QUALIFIED_CONFIGURATION}" requires the top-level Next config option reactCompiler: true.`,
      );
    }
    return;
  }

  if (
    config.reactCompiler !== true ||
    config.experimental?.reactCompiler === true
  ) {
    throw unsupported(
      `React Compiler qualification "${QUALIFIED_CONFIGURATION}" requires the top-level Next config option reactCompiler: true.`,
    );
  }
  if (qualification !== QUALIFIED_CONFIGURATION) {
    throw unsupported(
      `React Compiler transform ordering with PandamStyle is not qualified. Set reactCompilerQualification: "${QUALIFIED_CONFIGURATION}" only for the pinned Next 16.3.8, React 19.3.0 and ReactDOM 19.3.0 stack.`,
    );
  }

  const expected = {
    next: '16.3.8',
    react: '19.3.0',
    reactDom: '19.3.0',
  };
  for (const [name, version] of Object.entries(expected)) {
    if (installedVersions[name] !== version) {
      throw unsupported(
        `React Compiler qualification "${QUALIFIED_CONFIGURATION}" requires Next ${expected.next}, React ${expected.react} and ReactDOM ${expected.reactDom} (found ${name} ${installedVersions[name] ?? 'unavailable'}).`,
      );
    }
  }
}

export { QUALIFIED_CONFIGURATION as REACT_COMPILER_QUALIFICATION };
