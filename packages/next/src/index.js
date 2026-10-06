/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertReactCompilerQualification } from './react-compiler-contract.js';
import { createOwner, wireCompiler, unsupported } from './state.js';
import { configureTurbopack } from './turbopack-config.js';

const require = createRequire(import.meta.url);
const loader = fileURLToPath(new URL('./loader.cjs', import.meta.url));
const adapter = fileURLToPath(new URL('./adapter.js', import.meta.url));

export function withPandamStyle(options) {
  if (!['webpack', 'turbopack'].includes(options?.backend)) {
    throw unsupported(
      'withPandamStyle requires an explicit backend: webpack or turbopack.',
    );
  }
  if (options.backend === 'turbopack' && options.publicationMode == null) {
    throw unsupported(
      'TURBOPACK-DEV-SETTLEMENT: Turbopack requires an explicit publicationMode. Select semantic-dev for independent semantic development publication or strict for production.',
    );
  }
  if (
    (options.publicationMode != null &&
      !['strict', 'semantic-dev'].includes(options.publicationMode)) ||
    (options.backend === 'webpack' &&
      options.publicationMode === 'semantic-dev')
  )
    throw unsupported(
      'semantic-dev requires the explicit Turbopack backend; other publication modes are not qualified.',
    );
  if (
    !Array.isArray(options.roots) ||
    options.roots.length === 0 ||
    options.definition == null
  ) {
    throw unsupported(
      'withPandamStyle requires definition and at least one explicit source root.',
    );
  }
  const version = require('next/package.json').version;
  if (version !== '16.3.8')
    throw unsupported(
      `Next ${version} is outside the candidate target 16.3.8. This package does not qualify another Next line.`,
    );
  const userOptions = { ...options, roots: [...options.roots] };
  return (input = {}) =>
    async (phase, context) => {
      const config =
        typeof input === 'function' ? await input(phase, context) : input;
      if (config == null || typeof config !== 'object')
        throw unsupported('Next config must return an object.');
      if (
        config.adapterPath != null ||
        config.experimental?.adapterPath != null ||
        process.env.NEXT_ADAPTER_PATH
      ) {
        throw unsupported(
          'PandamStyle currently requires the Next adapterPath hook. Composition with another deployment adapter must be qualified before use.',
        );
      }
      if (
        options.backend === 'webpack' &&
        (config.experimental?.webpackBuildWorker === true ||
          config.experimental?.parallelServerCompiles ||
          config.experimental?.parallelServerBuildTraces)
      ) {
        throw unsupported(
          'This PandamStyle webpack candidate requires in-process compilation. Worker compilation needs a single-owner SDK transport, which is not qualified.',
        );
      }
      if (config.output != null)
        throw unsupported(
          'PandamStyle currently qualifies the standard Next output mode only. export/standalone need independent final-settlement qualification.',
        );
      const reactCompilerEnabled =
        config.reactCompiler === true ||
        config.experimental?.reactCompiler === true;
      const installedVersion = (name) => {
        try {
          return require(`${name}/package.json`).version;
        } catch {
          return null;
        }
      };
      assertReactCompilerQualification(
        config,
        options.reactCompilerQualification,
        {
          next: version,
          react: reactCompilerEnabled ? installedVersion('react') : null,
          reactDom: reactCompilerEnabled ? installedVersion('react-dom') : null,
        },
      );
      if (userOptions.backend === 'turbopack')
        return configureTurbopack(
          userOptions,
          { ...config, adapterPath: adapter },
          phase,
        );
      // Next also evaluates config in prerender/server children without CLI
      // arguments. Enforce explicit selection at the CLI entry process.
      if (
        (phase === 'phase-development-server' ||
          phase === 'phase-production-build') &&
        process.argv.some((value) => value === 'dev' || value === 'build')
      ) {
        if (
          !process.argv.includes('--webpack') ||
          process.argv.includes('--turbopack') ||
          process.argv.includes('--turbo')
        ) {
          throw unsupported(
            'Run Next 16.3.8 with --webpack explicitly (next dev --webpack / next build --webpack). Other launch modes are not qualified.',
          );
        }
      }
      let owner;
      return {
        ...config,
        adapterPath: adapter,
        webpack(webpackConfig, webpackContext) {
          const result =
            config.webpack?.(webpackConfig, webpackContext) ?? webpackConfig;
          if (result?.then)
            throw unsupported(
              'The public Next webpack callback must be synchronous.',
            );
          const root = path.resolve(result.context ?? process.cwd());
          owner ??= createOwner(
            root,
            userOptions,
            webpackContext.dev,
            config.distDir ?? '.next',
          );
          const sdkRule = (kind, extra) => ({
            ...extra,
            enforce: 'pre',
            use: [{ loader, options: { id: owner.id, kind } }],
          });
          result.module.rules.push(
            sdkRule('source', {
              test: /\.[cm]?[jt]sx?$/,
              include: owner.roots,
              exclude: /[\\/]node_modules[\\/]/,
            }),
          );
          result.module.rules.push(
            sdkRule('design', {
              type: 'javascript/auto',
              test: (file) =>
                file.startsWith(owner.hostDir + path.sep) &&
                path.basename(file) === 'design.js',
            }),
          );
          result.module.rules.push(
            sdkRule('css', {
              test: (file) =>
                file.startsWith(owner.hostDir + path.sep) &&
                path.basename(file) === 'styles.css',
            }),
          );
          result.plugins.push(
            new webpackContext.webpack.NormalModuleReplacementPlugin(
              /\.[cm]?[jt]sx?$/,
              (resource) => {
                const candidate = path.resolve(
                  resource.context,
                  resource.request.split('?')[0],
                );
                if (
                  candidate === owner.designPath &&
                  owner.transportDir != null
                )
                  resource.request = path.join(owner.transportDir, 'design.js');
              },
            ),
          );
          result.plugins.push({
            apply(compiler) {
              wireCompiler(owner, compiler);
            },
          });
          return result;
        },
      };
    };
}
