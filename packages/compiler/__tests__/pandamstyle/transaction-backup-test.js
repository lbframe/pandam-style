/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const compilerPath = path.resolve(
  __dirname,
  '../../../../.pms-test-support/compiler-inspection.cjs',
);
const compiler = require(compilerPath);
const { measure, openProject, comparePublished } = require('./session-helpers');

const original = {
  'js/a.js': 'export const a = 1;',
  'js/a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
  'js/remove.js': 'export const removed = true;',
  'js/remove.js.map': '{"version":3,"sources":["remove.ts"],"mappings":"AAAA"}',
  'design.d.ts': 'export declare const a: string;',
  'removed.d.ts': 'export declare const removed: boolean;',
  'styles.css': '.a { color: red; }',
  'artifact-index.json': '{"files":["js/a.js","js/remove.js"]}',
  'manifest.json': '{"version":1}',
};
const next = {
  'js/a.js': 'export const a = 2;',
  'js/a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AACA"}',
  'js/new/added.js': 'export const added = true;',
  'new.d.ts': 'export declare const added: boolean;',
  'design.d.ts': 'export declare const a: number;',
  'styles.css': '.a { color: blue; }',
  'artifact-index.json': '{"files":["js/a.js","js/new/added.js"]}',
  'manifest.json': '{"version":2}',
};
const boundaries = [
  'before-backup',
  'after-backup:js/a.js',
  'after-backup',
  'after-publish:js/a.js',
  'after-remove:js/remove.js',
  'before-manifest',
  'after-publish:manifest.json',
  'after-manifest',
];

describe('Phase 17B transaction backup and recovery', () => {
  let root;
  let out;
  const opts = { skipIdentical: true, incrementalBackup: true };
  function publish(files, options = opts) {
    const gen = compiler.beginGeneration(out, options);
    try {
      for (const [rel, text] of Object.entries(files)) gen.stage(rel, text);
      return gen.commit();
    } catch (err) {
      gen.rollback();
      throw err;
    }
  }
  function tree() {
    if (!fs.existsSync(out)) return null;
    return Object.fromEntries(
      fs
        .readdirSync(out, { recursive: true })
        .filter((rel) => fs.statSync(path.join(out, rel)).isFile())
        .sort()
        .map((rel) => [rel, fs.readFileSync(path.join(out, rel), 'utf8')]),
    );
  }
  function scratch() {
    return fs.readdirSync(root).filter((name) => name.includes('.pms-'));
  }
  function recover() {
    compiler.beginGeneration(out, opts).rollback();
    compiler.beginGeneration(out, opts).rollback(); // cleanup/recovery is idempotent
  }
  function crash(point, files = next, extra = {}) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
      const fs = require('fs');
      const path = require('path');
      const build = require(process.argv[1]);
      const out = process.argv[2];
      const options = JSON.parse(process.argv[4]);
      options.failAt = (p) => {
        if (p !== process.argv[3]) return;
        if (p === 'before-cleanup') {
          // Interrupt a partly released backup, not just an untouched one.
          const backup = path.join(path.dirname(out), '.out.pms-backup');
          const oldFile = fs.readdirSync(backup, { recursive: true })
            .find((rel) => fs.statSync(path.join(backup, rel)).isFile());
          if (oldFile) fs.unlinkSync(path.join(backup, oldFile));
        }
        process.exit(86);
      };
      const gen = build.beginGeneration(out, options);
      for (const [rel, text] of Object.entries(JSON.parse(process.argv[5]))) {
        if (options.mode === 'delta') gen.stageArtifact(rel, text);
        else gen.stage(rel, text);
      }
      gen.commit();
    `,
        compilerPath,
        out,
        point,
        JSON.stringify({ ...opts, ...extra }),
        JSON.stringify(files),
      ],
      { encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(86);
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-17b-'));
    out = path.join(root, 'out');
    publish(original);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('copies only dirty existing members; new and retained files have no backup', () => {
    const files = { ...original, 'js/a.js': 'changed', 'added.js': 'new' };
    delete files['removed.d.ts'];
    const copy = jest.spyOn(fs, 'copyFileSync');
    const link = jest.spyOn(fs, 'linkSync');
    const result = measure(() => publish(files));
    expect(
      copy.mock.calls.map(([from]) => path.relative(out, from)).sort(),
    ).toEqual(['js/a.js', 'removed.d.ts']);
    expect(link).not.toHaveBeenCalled();
    expect(result.counters.publication_backup_files).toBe(2);
    expect(result.counters.publication_backup_bytes).toBe(
      Buffer.byteLength(original['js/a.js'] + original['removed.d.ts']),
    );
    expect(result.value.delta.added).toBe(1);
    expect(tree()).toEqual(files);
    expect(scratch()).toEqual([]);
  });

  test('a no-change publication has zero backup copies and preserves retained inodes', () => {
    const inode = fs.statSync(path.join(out, 'js/a.js.map')).ino;
    const copy = jest.spyOn(fs, 'copyFileSync');
    const result = measure(() => publish(original));
    expect(copy).not.toHaveBeenCalled();
    expect(result.counters.publication_backup_files ?? 0).toBe(0);
    expect(result.counters.write_calls ?? 0).toBe(0);
    expect(fs.statSync(path.join(out, 'js/a.js.map')).ino).toBe(inode);
  });

  test.each(boundaries)(
    'failure at %s restores exact bytes and permits retry',
    (point) => {
      expect(() => publish(next, { ...opts, failAt: point })).toThrow(
        'injected',
      );
      expect(tree()).toEqual(original);
      recover();
      expect(scratch()).toEqual([]);
      publish(next);
      expect(tree()).toEqual(next);
    },
  );

  test.each(boundaries)('process exit at %s recovers exact bytes', (point) => {
    crash(point);
    recover();
    expect(tree()).toEqual(original);
    expect(scratch()).toEqual([]);
    publish(next);
    expect(tree()).toEqual(next);
  });

  test.each(['copyFileSync', 'renameSync', 'rmSync'])(
    '%s errors during undo publication are not swallowed',
    (method) => {
      const call = fs[method];
      let fired = false;
      jest.spyOn(fs, method).mockImplementation((...args) => {
        const target = method === 'rmSync' ? args[0] : args[1];
        const hit =
          method === 'copyFileSync'
            ? String(target).includes('.pms-backup')
            : target ===
              path.join(
                out,
                method === 'rmSync' ? 'js/remove.js' : 'design.d.ts',
              );
        if (!fired && hit) {
          fired = true;
          throw Object.assign(new Error('filesystem failure'), {
            code: 'EACCES',
          });
        }
        return call(...args);
      });
      expect(() => publish(next)).toThrow('filesystem failure');
      expect(fired).toBe(true);
      expect(tree()).toEqual(original);
      jest.restoreAllMocks();
      recover();
      publish(next);
      expect(tree()).toEqual(next);
    },
  );

  test('manifest is installed after replacements and removals including maps/types', () => {
    const rename = fs.renameSync;
    let witnessed = false;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === path.join(out, 'manifest.json')) {
        const before = tree();
        delete before['manifest.json'];
        const expected = { ...next };
        delete expected['manifest.json'];
        expect(before).toEqual(expected);
        witnessed = true;
      }
      return rename(from, to);
    });
    publish(next);
    expect(witnessed).toBe(true);
  });

  test.each([
    'design.d.ts',
    'new.d.ts',
    'js/a.js.map',
    'styles.css',
    'artifact-index.json',
  ])(
    'failure after publishing %s restores maps, declarations and manifest membership',
    (rel) => {
      expect(() =>
        publish(next, { ...opts, failAt: `after-publish:${rel}` }),
      ).toThrow('injected');
      expect(tree()).toEqual(original);
    },
  );

  test.each(['js/remove.js', 'removed.d.ts', 'js/remove.js.map'])(
    'one-file removal of %s can be undone',
    (rel) => {
      const files = { ...original };
      delete files[rel];
      expect(() =>
        publish(files, { ...opts, failAt: `after-remove:${rel}` }),
      ).toThrow('injected');
      expect(tree()).toEqual(original);
      publish(files);
      expect(tree()).toEqual(files);
    },
  );

  test('modified retained maps/types use captured original bytes for undo', () => {
    const gen = compiler.beginGeneration(out, {
      ...opts,
      failAt: 'after-manifest',
    });
    for (const [rel, text] of Object.entries(original)) gen.stage(rel, text);
    fs.writeFileSync(path.join(out, 'design.d.ts'), 'corrupt');
    fs.unlinkSync(path.join(out, 'js/a.js.map'));
    expect(() => gen.commit()).toThrow('injected');
    gen.rollback();
    expect(tree()).toEqual(original);
  });

  test('a failed first publication removes all additions and directories', () => {
    fs.rmSync(out, { recursive: true });
    crash('after-publish:js/a.js');
    recover();
    expect(tree()).toBe(null);
    expect(scratch()).toEqual([]);
  });

  test.each(['file', 'dangling link'])(
    'an output root containing a %s is rejected without deleting it',
    (kind) => {
      fs.rmSync(out, { recursive: true });
      if (kind === 'file') fs.writeFileSync(out, 'unrelated original bytes');
      else fs.symlinkSync(path.join(root, 'missing'), out);
      const occupiedOut = out;
      for (const incrementalBackup of [true, false]) {
        expect(() =>
          compiler.beginGeneration(occupiedOut, { incrementalBackup }),
        ).toThrow('output path exists and is not a directory');
        if (kind === 'file')
          expect(fs.readFileSync(out, 'utf8')).toBe('unrelated original bytes');
        else expect(fs.readlinkSync(out)).toBe(path.join(root, 'missing'));
        expect(scratch()).toEqual([]);
      }
    },
  );

  test('uncommitted undo failure preserves its journal and backups until recovery succeeds', () => {
    const gen = compiler.beginGeneration(out, {
      ...opts,
      failAt: 'after-manifest',
    });
    for (const [rel, text] of Object.entries(next)) gen.stage(rel, text);
    expect(() => gen.commit()).toThrow('injected');
    const copy = fs.copyFileSync;
    jest.spyOn(fs, 'copyFileSync').mockImplementation((...args) => {
      if (String(args[0]).includes('.pms-backup'))
        throw new Error('restore blocked');
      return copy(...args);
    });
    expect(() => gen.rollback()).toThrow('restore blocked');
    expect(scratch()).toContain('.out.pms-state.pending.json');
    jest.restoreAllMocks();
    recover();
    expect(tree()).toEqual(original);
    expect(scratch()).toEqual([]);
  });

  test.each(['undo', 'snapshot', 'delta'])(
    'interrupted partial cleanup of %s keeps the committed generation',
    (strategy) => {
      const options =
        strategy === 'delta'
          ? { mode: 'delta' }
          : { incrementalBackup: strategy === 'undo' };
      publish(original, options);
      crash('before-cleanup', next, options);
      recover();
      expect(tree()).toEqual(next);
      expect(
        scratch().filter((name) => !name.endsWith('.pms-state.json')),
      ).toEqual([]);
    },
  );

  test('post-commit cleanup error returns committed and defers idempotent release', () => {
    const result = publish(next, { ...opts, failAt: 'before-cleanup' });
    expect(result.mode).toBe('full');
    expect(tree()).toEqual(next);
    recover();
    expect(tree()).toEqual(next);
    expect(scratch()).toEqual([]);
  });

  test('symlink output shape falls back to a complete independent snapshot', () => {
    const external = path.join(root, 'external');
    fs.writeFileSync(external, 'original external');
    fs.symlinkSync(external, path.join(out, 'linked'));
    const gen = compiler.beginGeneration(out, opts);
    const journal = JSON.parse(
      fs.readFileSync(path.join(root, '.out.pms-state.pending.json')),
    );
    expect(journal.transaction.strategy).toBe('snapshot');
    fs.writeFileSync(external, 'changed external');
    gen.rollback();
    expect(fs.readFileSync(path.join(out, 'linked'), 'utf8')).toBe(
      'original external',
    );
  });

  test('invalid journal is rejected without destroying recovery data', () => {
    const pending = path.join(root, '.out.pms-state.pending.json');
    fs.writeFileSync(pending, '{broken');
    expect(() => recover()).toThrow();
    expect(tree()).toEqual(original);
    expect(fs.readFileSync(pending, 'utf8')).toBe('{broken');
  });

  test.each(['EXDEV', 'EPERM'])(
    '%s manifest rename failure rolls back without a live-copy fallback',
    (code) => {
      const rename = fs.renameSync;
      let fired = false;
      jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (!fired && to === path.join(out, 'manifest.json')) {
          fired = true;
          throw Object.assign(new Error(code), { code });
        }
        return rename(from, to);
      });
      expect(() => publish(next)).toThrow(code);
      expect(fired).toBe(true);
      expect(tree()).toEqual(original);
    },
  );

  test('declaration staging failure leaves previous output intact', () => {
    const write = fs.writeFileSync;
    jest.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('.pms-staging/design.d.ts'))
        throw new Error('declaration write failed');
      return write(file, ...args);
    });
    expect(() => publish(next)).toThrow('declaration write failed');
    expect(tree()).toEqual(original);
    expect(scratch()).toEqual([]);
  });

  test('explicit reclaim cannot republish its previously staged member', () => {
    const gen = compiler.beginGeneration(out, opts);
    for (const [rel, text] of Object.entries(original)) gen.stage(rel, text);
    gen.reclaim('removed.d.ts');
    gen.commit();
    const expected = { ...original };
    delete expected['removed.d.ts'];
    expect(tree()).toEqual(expected);
  });

  test('unsupported directory replacement fails before removing its prior members', () => {
    const before = { ...original, 'nested/old.js': 'original nested bytes' };
    publish(before);
    const files = { ...next, nested: 'file replacing a directory' };
    expect(() => publish(files)).toThrow(
      'artifact replaces an output directory',
    );
    expect(tree()).toEqual(before);
    recover();
    expect(tree()).toEqual(before);
    expect(scratch()).toEqual([]);
  });

  test('interrupted manifest removal recovers a publication with no manifest', () => {
    const files = { ...next };
    delete files['manifest.json'];
    crash('after-remove:manifest.json', files);
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);
    recover();
    expect(tree()).toEqual(original);
  });

  test('delta rollback restoration failure preserves a recoverable prior root', () => {
    const options = { mode: 'delta' };
    publish(original, options);
    const gen = compiler.beginGeneration(out, {
      ...options,
      failAt: 'after-swap',
    });
    for (const [rel, text] of Object.entries(next))
      gen.stageArtifact(rel, text);
    expect(() => gen.commit()).toThrow('injected');
    const copy = fs.copyFileSync;
    jest.spyOn(fs, 'copyFileSync').mockImplementation((...args) => {
      if (String(args[0]).includes('.pms-backup'))
        throw new Error('restore denied');
      return copy(...args);
    });
    expect(() => gen.rollback()).toThrow('restore denied');
    jest.restoreAllMocks();
    recover();
    expect(tree()).toEqual(original);
    expect(scratch()).toEqual(['.out.pms-state.json']);
  });

  test('canonical full session selects bounded backup without changing fresh equivalence', () => {
    const h = openProject('valid');
    try {
      h.revise({ initial: true });
      const source = h.src('src/page.tsx');
      fs.writeFileSync(
        source,
        fs
          .readFileSync(source, 'utf8')
          .replace("gap: token('spacing.md'),", "gap: token('spacing.lg'),"),
      );
      const result = measure(() => h.revise());
      expect(result.value.ok).toBe(true);
      expect(result.counters.publication_backup_files).toBeLessThan(
        result.counters.publication_candidates,
      );
      expect(comparePublished(h).findings).toEqual([]);
    } finally {
      h.session.close();
    }
  });
});
