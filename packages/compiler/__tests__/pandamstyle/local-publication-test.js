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
const { measure, openProject, comparePublished } = require('./session-helpers');
const compiler = require('../../../../.pms-test-support/compiler-inspection.cjs');

describe('Phase 17A: transform validity input reuse', () => {
  let h;
  beforeEach(() => {
    h = openProject('valid');
    h.revise({ initial: true });
  });
  afterEach(() => h.session.close());

  test('unchanged transforms compare their inputs without hashing them again', () => {
    const result = measure(() => h.revise());
    expect(result.value.ok).toBe(true);
    expect(result.value.counters.filesRecompiled).toBe(0);
    expect(result.counters.validity_checks).toBe(
      result.value.counters.filesReused,
    );
    expect(result.counters.validity_input_hashes).toBe(1);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a changed local source refreshes its key and matches fresh publication', () => {
    const file = h.src('src/page.tsx');
    const before = h.session.validityOf(file);
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace("gap: token('spacing.md'),", "gap: token('spacing.lg'),"),
    );
    const result = measure(() => h.revise());
    expect(result.value.ok).toBe(true);
    expect(result.value.counters.filesRecompiled).toBe(1);
    expect(result.counters.validity_input_hashes).toBe(4);
    expect(h.session.validityOf(file).sourceHash).not.toBe(before.sourceHash);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('publication computes one canonical path per compiled output', () => {
    const result = measure(() => h.revise());
    expect(result.counters.publication_output_paths).toBe(
      result.value.counters.filesRecompiled + result.value.counters.filesReused,
    );
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('canonical delta publication repairs deleted CSS without recompiling sources', () => {
    h.session.close();
    h = openProject('valid', {
      publishVariant: 'session_incremental_publish_css',
    });
    h.revise({ initial: true });
    const css = fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8');
    fs.rmSync(path.join(h.outDir, 'styles.css'));
    const result = h.revise();
    expect(result.ok).toBe(true);
    expect(result.counters.filesRecompiled).toBe(0);
    expect(h.session.lastPublication().byKind.css.changed).toBe(1);
    expect(fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8')).toBe(
      css,
    );
    expect(comparePublished(h).findings).toEqual([]);
  });
});

describe('Phase 17A: publication filesystem checks', () => {
  let root;
  let out;
  const payload = {
    'js/a.js': 'export const a = 1;',
    'js/b.js': 'export const b = 1;',
    'js/a.js.map': '{"version":3,"sources":["a.ts"],"mappings":"AAAA"}',
    'styles.css': '.a { color: red; }',
    'design.d.ts': 'export declare const a: string;',
    'artifact-index.json': '{"files":["js/a.js","js/b.js"]}',
    'manifest.json': '{"version":1}',
  };
  function publish(files = payload, mode = 'full', options = {}) {
    return compiler.withGeneration(
      out,
      (gen) => {
        for (const [file, text] of Object.entries(files)) {
          if (mode === 'delta') gen.stageArtifact(file, text);
          else gen.stage(file, text);
        }
      },
      { mode, ...options },
    );
  }
  function contents() {
    const result = {};
    for (const file of fs.readdirSync(out, { recursive: true })) {
      const target = path.join(out, file);
      if (fs.statSync(target).isFile())
        result[file] = fs.readFileSync(target, 'utf8');
    }
    return result;
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-17a-'));
    out = path.join(root, 'out');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('backup copies use directory entries instead of restatting ordinary files', () => {
    publish();
    const stat = jest.spyOn(fs, 'statSync');
    publish();
    expect(
      stat.mock.calls.filter(([file]) =>
        Object.keys(payload).some((rel) => file === path.join(out, rel)),
      ),
    ).toEqual([]);
    expect(contents()).toEqual(payload);
  });

  test('full publication creates each destination directory once', () => {
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    publish();
    expect(
      mkdir.mock.calls.filter(([dir]) => dir === path.join(out, 'js')),
    ).toHaveLength(1);
    expect(contents()).toEqual(payload);
  });

  test('backup copying continues to follow symlinks and restores their bytes', () => {
    publish();
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'file'), 'original');
    fs.symlinkSync(external, path.join(out, 'linked'));
    const gen = compiler.beginGeneration(out);
    fs.writeFileSync(path.join(external, 'file'), 'changed externally');
    gen.rollback();
    expect(fs.readFileSync(path.join(out, 'linked/file'), 'utf8')).toBe(
      'original',
    );
  });

  test.each(['writeFileSync', 'renameSync'])(
    '%s failure restores all previous members and permits recovery',
    (method) => {
      publish();
      const original = fs[method];
      let failed = false;
      jest.spyOn(fs, method).mockImplementation((...args) => {
        const target = method === 'writeFileSync' ? args[0] : args[1];
        if (
          !failed &&
          (method === 'writeFileSync'
            ? String(target).includes('.pms-staging')
            : target === path.join(out, 'js/b.js'))
        ) {
          failed = true;
          throw new Error('injected filesystem failure');
        }
        return original(...args);
      });
      expect(() => publish({ ...payload, 'js/a.js': 'changed' })).toThrow(
        'injected filesystem failure',
      );
      expect(failed).toBe(true);
      expect(contents()).toEqual(payload);
      jest.restoreAllMocks();
      publish({ ...payload, 'js/a.js': 'recovered' });
      expect(contents()).toEqual({ ...payload, 'js/a.js': 'recovered' });
    },
  );

  test('delta skips unchanged declarations, manifest and maps and refreshes changed members', () => {
    publish(payload, 'delta');
    const mapInode = fs.statSync(path.join(out, 'js/a.js.map')).ino;
    const result = publish(
      { ...payload, 'styles.css': '.a { color: blue; }' },
      'delta',
    );
    expect(result).toBeUndefined(); // withGeneration returns the callback value.
    expect(fs.statSync(path.join(out, 'js/a.js.map')).ino).toBe(mapInode);
    expect(contents()).toEqual({
      ...payload,
      'styles.css': '.a { color: blue; }',
    });
    const refreshed = {
      ...payload,
      'design.d.ts': 'export declare const a: number;',
      'manifest.json': '{"version":2}',
      'artifact-index.json': '{"files":["js/a.js"]}',
    };
    delete refreshed['js/b.js'];
    publish(refreshed, 'delta');
    expect(contents()).toEqual(refreshed);
  });

  test('missing output and removed artifact recover to the complete desired file set', () => {
    publish(payload, 'delta');
    fs.rmSync(out, { recursive: true });
    publish(payload, 'delta');
    expect(contents()).toEqual(payload);
    const removed = { ...payload };
    delete removed['js/b.js'];
    publish(removed, 'delta');
    expect(contents()).toEqual(removed);
  });

  test('asynchronous staging also rolls back a commit failure', async () => {
    publish(payload, 'delta');
    await expect(
      compiler.withGeneration(
        out,
        async (gen) => {
          for (const [file, text] of Object.entries(payload))
            gen.stageArtifact(file, text + '\n');
        },
        { mode: 'delta', failAt: 'after-swap' },
      ),
    ).rejects.toThrow('injected publication failure');
    expect(contents()).toEqual(payload);
    publish(payload, 'delta');
    expect(contents()).toEqual(payload);
  });

  test('session byte comparison retains identical members without writes or renames', () => {
    publish();
    const inodes = Object.fromEntries(
      Object.keys(payload).map((file) => [
        file,
        fs.statSync(path.join(out, file)).ino,
      ]),
    );
    const write = jest.spyOn(fs, 'writeFileSync');
    const rename = jest.spyOn(fs, 'renameSync');
    const result = measure(() =>
      publish(payload, 'full', { skipIdentical: true }),
    );
    expect(result.counters.output_files_reused).toBe(
      Object.keys(payload).length,
    );
    expect(result.counters.write_calls ?? 0).toBe(0);
    // Transaction control records may be written; identical artifact bytes may
    // not be written into either staging or live output.
    expect(
      write.mock.calls.filter(
        ([target]) =>
          String(target).includes('.pms-staging') ||
          String(target).startsWith(out + path.sep),
      ),
    ).toEqual([]);
    expect(
      rename.mock.calls.filter(
        ([, target]) =>
          target === out || String(target).startsWith(out + path.sep),
      ),
    ).toEqual([]);
    expect(contents()).toEqual(payload);
    for (const [file, inode] of Object.entries(inodes)) {
      expect(fs.statSync(path.join(out, file)).ino).toBe(inode);
    }
  });

  test('byte comparison refreshes CSS, declarations, manifest and index and reclaims removed output', () => {
    publish();
    const mapInode = fs.statSync(path.join(out, 'js/a.js.map')).ino;
    const next = {
      ...payload,
      'styles.css': '.a { color: blue; }',
      'design.d.ts': 'export declare const a: number;',
      'manifest.json': '{"version":2}',
      'artifact-index.json': '{"files":["js/a.js"]}',
    };
    delete next['js/b.js'];
    const result = measure(() =>
      publish(next, 'full', { skipIdentical: true }),
    );
    expect(result.counters.write_calls).toBe(4);
    expect(result.counters.output_files_removed).toBe(1);
    expect(fs.statSync(path.join(out, 'js/a.js.map')).ino).toBe(mapInode);
    expect(contents()).toEqual(next);
  });

  test('retained files modified or deleted after preparation are repaired before commit', () => {
    publish();
    const gen = compiler.beginGeneration(out, { skipIdentical: true });
    for (const [file, text] of Object.entries(payload)) gen.stage(file, text);
    fs.writeFileSync(path.join(out, 'js/a.js'), 'tampered');
    fs.rmSync(path.join(out, 'js/a.js.map'));
    const result = gen.commit();
    expect(result.delta.changed).toBe(2);
    expect(result.delta.reused).toBe(Object.keys(payload).length - 2);
    expect(contents()).toEqual(payload);
  });

  test('unreadable output during byte comparison is staged again', () => {
    publish();
    const read = fs.readFileSync;
    let failed = false;
    jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (!failed && file === path.join(out, 'js/a.js')) {
        failed = true;
        throw new Error('injected read failure');
      }
      return read(file, ...args);
    });
    const result = measure(() =>
      publish(payload, 'full', { skipIdentical: true }),
    );
    expect(failed).toBe(true);
    expect(result.counters.write_calls).toBe(1);
    expect(contents()).toEqual(payload);
  });

  test.each(['writeFileSync', 'renameSync'])(
    'retained publication recovers from %s failure',
    (method) => {
      publish();
      const original = fs[method];
      let failed = false;
      jest.spyOn(fs, method).mockImplementation((...args) => {
        const target = method === 'writeFileSync' ? args[0] : args[1];
        if (
          !failed &&
          (method === 'writeFileSync'
            ? String(target).includes('.pms-staging')
            : target === path.join(out, 'js/a.js'))
        ) {
          failed = true;
          throw new Error('injected retaining failure');
        }
        return original(...args);
      });
      const next = { ...payload, 'js/a.js': 'changed' };
      expect(() => publish(next, 'full', { skipIdentical: true })).toThrow(
        'injected retaining failure',
      );
      expect(failed).toBe(true);
      expect(contents()).toEqual(payload);
      jest.restoreAllMocks();
      publish(next, 'full', { skipIdentical: true });
      expect(contents()).toEqual(next);
    },
  );

  test('missing output bootstraps all byte-compared members again', () => {
    publish();
    fs.rmSync(out, { recursive: true });
    const result = measure(() =>
      publish(payload, 'full', { skipIdentical: true }),
    );
    expect(result.counters.write_calls).toBe(Object.keys(payload).length);
    expect(contents()).toEqual(payload);
  });

  test('fresh reference staging remains independent and unconditional', () => {
    publish();
    const result = measure(() => publish());
    expect(result.counters.write_calls).toBe(Object.keys(payload).length);
    expect(result.counters.output_files_reused ?? 0).toBe(0);
    expect(contents()).toEqual(payload);
  });

  test('retaining a Buffer captures its bytes at staging time', () => {
    publish();
    const gen = compiler.beginGeneration(out, { skipIdentical: true });
    for (const [file, text] of Object.entries(payload)) {
      const bytes = Buffer.from(text);
      gen.stage(file, bytes);
      bytes.fill(88);
    }
    gen.commit();
    expect(contents()).toEqual(payload);
  });

  test('delta installs repaired maps even when desired digests match the durable records', () => {
    publish(payload, 'delta');
    fs.rmSync(path.join(out, 'js/a.js.map'));
    const gen = compiler.beginGeneration(out, { mode: 'delta' });
    for (const [file, text] of Object.entries(payload))
      gen.stageArtifact(file, text);
    const result = gen.commit();
    expect(result.delta.changed).toBe(1);
    expect(result.generationReused).toBe(false);
    expect(contents()).toEqual(payload);
  });

  test('an interrupted backup copy never replaces the complete previous output', () => {
    publish();
    const child = spawnSync(process.execPath, [
      '-e',
      `
      const fs = require('fs');
      const copy = fs.copyFileSync;
      let copies = 0;
      fs.copyFileSync = (...args) => {
        if (++copies === 2) process.exit(86);
        return copy(...args);
      };
      require(process.argv[1]).beginGeneration(process.argv[2]);
    `,
      path.resolve(
        __dirname,
        '../../../../.pms-test-support/compiler-inspection.cjs',
      ),
      out,
    ]);
    expect(child.status).toBe(86);
    expect(contents()).toEqual(payload);
    publish(payload, 'full', { skipIdentical: true });
    expect(contents()).toEqual(payload);
    expect(
      fs.readdirSync(root).filter((name) => name.includes('.pms-')),
    ).toEqual([]);
  });

  test.each(['copyFileSync', 'renameSync'])(
    'failed backup %s keeps complete output and recovers next revision',
    (method) => {
      publish();
      const original = fs[method];
      let calls = 0;
      jest.spyOn(fs, method).mockImplementation((...args) => {
        if (++calls === (method === 'copyFileSync' ? 2 : 1)) {
          throw new Error('injected backup failure');
        }
        return original(...args);
      });
      expect(() => publish(payload, 'full', { skipIdentical: true })).toThrow(
        'injected backup failure',
      );
      expect(contents()).toEqual(payload);
      jest.restoreAllMocks();
      publish(payload, 'full', { skipIdentical: true });
      expect(contents()).toEqual(payload);
      expect(
        fs.readdirSync(root).filter((name) => name.includes('.pms-')),
      ).toEqual([]);
    },
  );
});
