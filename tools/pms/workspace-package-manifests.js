/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { globSync } = require('glob');

function listWorkspacePackages(repoRoot) {
  const root = path.resolve(repoRoot);
  const rootManifestPath = path.join(root, 'package.json');
  const rootManifest = JSON.parse(fs.readFileSync(rootManifestPath, 'utf8'));
  const workspaceSpec = rootManifest.workspaces;
  const patterns = Array.isArray(workspaceSpec)
    ? workspaceSpec
    : workspaceSpec?.packages;

  if (
    !Array.isArray(patterns) ||
    patterns.some((pattern) => typeof pattern !== 'string')
  ) {
    throw new Error('WORKSPACE_INVENTORY_INVALID: package.json workspaces');
  }

  const includePatterns = patterns.filter(
    (pattern) => pattern.length > 0 && !pattern.startsWith('!'),
  );
  const excludePatterns = patterns
    .filter((pattern) => pattern.startsWith('!'))
    .map((pattern) => pattern.slice(1));
  if (includePatterns.length === 0) {
    throw new Error('WORKSPACE_INVENTORY_EMPTY: no included workspace roots');
  }

  const expandDirectories = (pattern) =>
    globSync(pattern, {
      cwd: root,
      absolute: true,
      onlyDirectories: true,
      dot: true,
    }).map((directory) => path.resolve(directory));
  const included = new Set();
  for (const pattern of includePatterns) {
    const matches = expandDirectories(pattern);
    if (matches.length === 0) {
      throw new Error(`WORKSPACE_PATTERN_UNMATCHED: ${pattern}`);
    }
    for (const directory of matches) included.add(directory);
  }
  const excluded = new Set(
    excludePatterns.flatMap((pattern) => expandDirectories(pattern)),
  );
  const directories = [...included]
    .filter((directory) => !excluded.has(directory))
    .sort();
  const outside = directories.filter((directory) => {
    const relative = path.relative(root, directory);
    return (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    );
  });
  if (outside.length > 0) {
    throw new Error(
      `WORKSPACE_OUTSIDE_REPOSITORY: ${outside.map((item) => path.relative(root, item)).join(', ')}`,
    );
  }

  const missing = directories
    .map((directory) => path.join(directory, 'package.json'))
    .filter((manifestPath) => !fs.existsSync(manifestPath));
  if (missing.length > 0) {
    throw new Error(
      `WORKSPACE_MANIFEST_MISSING: ${missing.map((item) => path.relative(root, item)).join(', ')}`,
    );
  }

  return directories.map((directory) => {
    const manifestPath = path.join(directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new Error(
        `WORKSPACE_PACKAGE_NAME_MISSING: ${path.relative(root, manifestPath)}`,
      );
    }
    return {
      name: manifest.name,
      manifestPath: path.relative(root, manifestPath).split(path.sep).join('/'),
    };
  });
}

function assertUniqueWorkspacePackageNames(repoRoot) {
  const packages = listWorkspacePackages(repoRoot);
  const byName = new Map();
  for (const item of packages) {
    const paths = byName.get(item.name) ?? [];
    paths.push(item.manifestPath);
    byName.set(item.name, paths);
  }
  const duplicates = [...byName.entries()].filter(
    ([, paths]) => paths.length > 1,
  );
  if (duplicates.length > 0) {
    const detail = duplicates
      .map(([name, paths]) => `${name}: ${paths.join(', ')}`)
      .join('; ');
    throw new Error(`DUPLICATE_WORKSPACE_PACKAGE_NAMES: ${detail}`);
  }
  return packages;
}

module.exports = { assertUniqueWorkspacePackageNames, listWorkspacePackages };
