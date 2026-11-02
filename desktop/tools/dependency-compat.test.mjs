import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodeFs from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

// An isolated fixture graph can run these same consumer tests before the full
// Desktop install. Normal CI resolves the actual Desktop dependency graph.
const desktop = process.env.DEPENDENCY_COMPAT_ROOT || fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(desktop, 'package.json'));
const legacyRequire = process.env.DEPENDENCY_COMPAT_ROOT
  ? require
  : createRequire(require.resolve('app-builder-lib/package.json'));
const legacyAsarName = process.env.DEPENDENCY_COMPAT_ROOT ? 'asar3' : '@electron/asar';
const asar3 = legacyRequire(legacyAsarName);
const asar4 = require(process.env.DEPENDENCY_COMPAT_ROOT ? 'asar4' : '@electron/asar');
// ASAR is installed on every supported platform. Unix installer parents omit
// electron-installer-common on Windows, so it cannot anchor shared glob tests.
const glob = createRequire(legacyRequire.resolve(legacyAsarName))('glob');
const minimatch = createRequire(require.resolve('dir-compare/package.json'))('minimatch');
const globAsync = promisify(glob);

test('each locked consumer resolves its required API and no vulnerable matcher remains', async () => {
  const lock = JSON.parse(await readFile(path.join(desktop, 'package-lock.json'), 'utf8'));
  const semver = require('semver');
  let legacyEdges = 0;
  let modernEdges = 0;
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location.includes('node_modules/')) continue;
    const identity = entry.name || location.split('node_modules/').at(-1);
    if (identity === 'minimatch') assert.ok(semver.gte(entry.version, '11.0.3'), location);
    if (identity === 'glob') assert.ok(semver.gte(entry.version, '14.0.3'), location);
    const adapter =
      identity === '@concordvoice/glob-compat' || identity === '@concordvoice/minimatch-compat';
    if (!adapter && !entry.dependencies?.glob && !entry.dependencies?.minimatch) continue;
    let actual;
    try {
      actual = JSON.parse(await readFile(path.join(desktop, location, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' && entry.optional) continue;
      throw error;
    }
    const parent = createRequire(path.join(desktop, location, 'package.json'));
    for (const dep of ['glob', 'minimatch']) {
      const range = entry.dependencies?.[dep];
      if (!range || !semver.validRange(range)) continue;
      const floor = dep === 'glob' ? 9 : 6;
      const legacy = semver.minVersion(range).major < floor;
      const actual = parent(`${dep}/package.json`);
      assert.equal(
        actual.name,
        legacy ? `@concordvoice/${dep}-compat` : dep,
        `${location} -> ${dep}`
      );
      if (legacy) legacyEdges++;
      else {
        modernEdges++;
        assert.ok(semver.gte(actual.version, dep === 'glob' ? '14.0.3' : '11.0.3'));
      }
    }
    if (actual.name === 'minimatch') assert.ok(semver.gte(actual.version, '11.0.3'), location);
    if (actual.name === 'glob') assert.ok(semver.gte(actual.version, '14.0.3'), location);
    if (
      actual.name === '@concordvoice/glob-compat' ||
      actual.name === '@concordvoice/minimatch-compat'
    ) {
      assert.equal(entry.dev, process.env.DEPENDENCY_COMPAT_ROOT ? undefined : true, location);
      assert.notEqual(entry.link, true, 'adapters must be packed, not source-checkout links');
      if (!process.env.DEPENDENCY_COMPAT_ROOT) {
        const source = path.join(desktop, 'tools', actual.name.split('/').at(-1));
        for (const file of ['index.cjs', 'package.json']) {
          assert.equal(
            await readFile(path.join(desktop, location, file), 'utf8'),
            await readFile(path.join(source, file), 'utf8'),
            `${location}/${file} must match current source`
          );
        }
      }
    }
  }
  assert.ok(legacyEdges > 0);
  assert.ok(modernEdges > 0);
});

async function fixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'concord-packaging-compat-'));
  try {
    await mkdir(path.join(dir, 'nested'));
    for (const [name, content] of Object.entries({
      'z.txt': 'upper',
      'a.txt': 'lower',
      '.hidden.txt': 'hidden',
      'nested/b.txt': 'nested',
      'nested/skip.log': 'log',
      'keep.bin': 'keep',
    }))
      await writeFile(path.join(dir, name), content);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('legacy callback and sync glob preserve selection, sorting, options and brace detection', async () => {
  await fixture(async (dir) => {
    // Use an explicit expected set, not one implementation as its own oracle.
    const expected = ['.hidden.txt', 'z.txt', 'a.txt', 'nested/b.txt'].sort((a, b) =>
      a.localeCompare(b, 'en')
    );
    const opts = { cwd: dir, dot: true };
    assert.deepEqual(glob.sync('**/*.txt', opts), expected);
    assert.deepEqual(await globAsync('**/*.txt', opts), expected);
    assert.deepEqual(await globAsync(path.join(dir, '*.bin')), [
      path.join(dir, 'keep.bin').split(path.sep).join('/'),
    ]);
    assert.deepEqual(
      glob.sync('**/*.txt', { ...opts, ignore: 'nested/**' }),
      expected.filter((x) => !x.startsWith('nested/'))
    );
    assert.deepEqual(
      glob.sync('**', { ...opts, nodir: true }).filter((x) => x.endsWith('/')),
      []
    );
    assert.ok(glob.sync('*', { cwd: dir, mark: true }).includes('nested/'));
    assert.deepEqual(glob.sync('missing*.txt', opts), []);
    assert.equal(glob.hasMagic('{z,a}.txt'), true);
    assert.equal(glob.hasMagic('{z,a}.txt', { nobrace: true }), false);
    assert.equal(glob.hasMagic('plain.txt'), false);
    assert.equal(glob.glob, glob);
  });
});

test('callback errors are delivered once and unsupported contracts fail explicitly', async () => {
  let calls = 0;
  await new Promise((resolve) =>
    glob(null, (error) => {
      calls++;
      assert.ok(error instanceof TypeError);
      resolve();
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.throws(() => glob('*'), /requires a callback/);
  assert.throws(() => glob.sync('*', { nonull: true }), /does not support option nonull/);
  await assert.rejects(globAsync('*', { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('callable minimatch retains helpers without recreating removed regexp internals', () => {
  assert.equal(minimatch('nested/b.txt', '*.txt', { matchBase: true }), true);
  assert.deepEqual(minimatch.match(['a.txt', 'b.log'], '*.txt'), ['a.txt']);
  const matcher = new minimatch.Minimatch('**/*.txt');
  assert.equal(matcher.match('nested/b.txt'), true);
  assert.equal(matcher.match('nested', true), true);
  assert.equal(matcher.set[0][0], minimatch.GLOBSTAR);
  assert.equal(matcher.set[0][1] instanceof RegExp, false);
  assert.equal(typeof matcher.set[0][1], 'object');
  assert.equal(minimatch.makeRe, undefined);
  assert.equal(matcher.makeRe, undefined);
});

test('legacy and modern ASAR preserve files, links, extraction and unpack selection', async () => {
  await fixture(async (dir) => {
    const src = path.join(dir, 'src');
    await mkdir(path.join(src, 'nested'), { recursive: true });
    await writeFile(path.join(src, 'package.json'), '{"name":"fixture","version":"1.0.0"}');
    await writeFile(path.join(src, 'nested', 'payload.txt'), 'payload');
    await writeFile(path.join(src, '.hidden'), 'hidden');
    await symlink(
      process.platform === 'win32' ? path.join(src, 'nested') : 'nested',
      path.join(src, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const archives = [];
    for (const [name, asar] of [
      ['legacy', asar3],
      ['modern', asar4],
    ]) {
      const archive = path.join(dir, `${name}.asar`);
      await asar.createPackageWithOptions(src, archive, { unpack: '**/*.txt' });
      const files = asar
        .listPackage(archive)
        .map((file) => file.split(path.sep).join('/'))
        .sort();
      assert.ok(files.includes('/.hidden'));
      assert.ok(files.includes('/linked'));
      assert.ok(!files.includes('/linked/payload.txt'));
      assert.equal(
        asar.extractFile(archive, 'package.json').toString(),
        '{"name":"fixture","version":"1.0.0"}'
      );
      assert.equal(await readFile(`${archive}.unpacked/nested/payload.txt`, 'utf8'), 'payload');
      archives.push(files);
    }
    assert.deepEqual(archives[0], archives[1]);
  });
});

test('actual legacy cleanup removes only matches through callback and sync APIs', async () => {
  const rimraf3 = require(process.env.DEPENDENCY_COMPAT_ROOT ? 'rimraf3' : 'rimraf');
  const rimraf2 = process.env.DEPENDENCY_COMPAT_ROOT
    ? require('rimraf2')
    : createRequire(require.resolve('temp/package.json'))('rimraf');
  for (const rimraf of [rimraf2, rimraf3]) {
    await fixture(async (dir) => {
      await promisify(rimraf)(path.join(dir, '{z,a}.txt'));
      assert.equal(await readFile(path.join(dir, 'keep.bin'), 'utf8'), 'keep');
      assert.ok(!(await readdir(dir)).includes('a.txt'));
      rimraf.sync(path.join(dir, 'nested/*.log'));
      assert.equal(await readFile(path.join(dir, 'nested/b.txt'), 'utf8'), 'nested');
    });
  }
});

test(
  'installer resource discovery reads package metadata using its real callback glob',
  {
    skip: process.platform === 'win32' && 'Debian/RPM installer parents support only darwin/linux',
  },
  async () => {
    const installerRequire = createRequire(
      require.resolve('electron-installer-common/package.json')
    );
    await fixture(async (dir) => {
      const resources = path.join(dir, 'Fixture.app/Contents/Resources/app');
      await mkdir(resources, { recursive: true });
      const manifest = { name: 'fixture', version: '1.0.0' };
      await writeFile(path.join(resources, 'package.json'), JSON.stringify(manifest));
      const readMetadata = installerRequire('./src/readmetadata.js');
      assert.deepEqual(await readMetadata({ src: dir, logger() {} }), manifest);
    });
  }
);

test('dir-compare filters use the legacy callable matcher correctly', () => {
  const {
    defaultFilterHandler,
  } = require('dir-compare/build/src/FilterHandler/defaultFilterHandler.js');
  const file = (name) => ({ name, stat: { isFile: () => true } });
  assert.equal(defaultFilterHandler(file('a.txt'), '/nested', { includeFilter: '*.txt' }), true);
  assert.equal(defaultFilterHandler(file('a.log'), '/nested', { includeFilter: '*.txt' }), false);
  assert.equal(defaultFilterHandler(file('.hidden'), '/nested', { excludeFilter: '.*' }), false);
});

test('filelist and ESLint legacy overrides retain selection and exclusion semantics', async () => {
  await fixture(async (dir) => {
    const { FileList } = require('filelist');
    const files = new FileList();
    files.include(path.join(dir, '**/*.txt'));
    files.exclude(path.join(dir, 'nested/**'));
    assert.deepEqual(
      files
        .toArray()
        .map((x) => path.basename(x))
        .sort(),
      ['a.txt', 'z.txt']
    );
    const eslintRoot = path.dirname(require.resolve('@eslint/eslintrc/package.json'));
    const { OverrideTester } = await import(
      pathToFileURL(path.join(eslintRoot, 'lib/config-array/override-tester.js'))
    );
    const tester = OverrideTester.create(['**/*.txt'], ['nested/**'], dir);
    assert.equal(tester.test(path.join(dir, 'a.txt')), true);
    assert.equal(tester.test(path.join(dir, '.hidden.txt')), true);
    assert.equal(tester.test(path.join(dir, 'nested/b.txt')), false);
  });
});

test('builder file filtering retains literals, magic, exclusions and directory traversal', async () => {
  await fixture(async (dir) => {
    const { FileMatcher } = require('app-builder-lib/out/fileMatcher.js');
    const { hasMagic } = require('app-builder-lib/out/util/filter.js');
    const mm = legacyRequire('minimatch');
    assert.equal(hasMagic(new mm.Minimatch('nested')), false);
    assert.equal(hasMagic(new mm.Minimatch('*.txt')), true);
    const matcher = new FileMatcher(dir, path.join(dir, 'out'), (x) => x, [
      '**/*.txt',
      '!nested/skip*',
    ]);
    const filter = matcher.createFilter();
    assert.equal(filter(path.join(dir, 'nested'), { isDirectory: () => true }), true);
    assert.equal(filter(path.join(dir, 'nested/b.txt'), { isDirectory: () => false }), true);
    assert.equal(filter(path.join(dir, 'nested/skip.txt'), { isDirectory: () => false }), false);
    assert.equal(filter(path.join(dir, '.hidden.txt'), { isDirectory: () => false }), true);
    const literal = new FileMatcher(dir, path.join(dir, 'out'), (x) => x, [
      'nested',
    ]).createFilter();
    assert.equal(literal(path.join(dir, 'nested/b.txt'), { isDirectory: () => false }), true);
    assert.equal(literal(path.join(dir, 'a.txt'), { isDirectory: () => false }), false);
  });
});

test('legacy traversal propagates unexpected readdir errors without returning partial results', async () => {
  await fixture(async (dir) => {
    const blocked = path.join(dir, 'nested');
    for (const code of ['EACCES', 'EIO', 'EPERM']) {
      const failure = Object.assign(new Error(`injected ${code}`), { code, path: blocked });
      const fs = {
        readdir(directory, options, callback) {
          if (directory === blocked) return queueMicrotask(() => callback(failure));
          nodeFs.readdir(directory, options, callback);
        },
        readdirSync(directory, options) {
          if (directory === blocked) throw failure;
          return nodeFs.readdirSync(directory, options);
        },
      };
      let callbacks = 0;
      await new Promise((resolve, reject) => {
        glob('**/*.txt', { cwd: dir, fs }, (error, matches) => {
          callbacks++;
          try {
            assert.equal(error, failure);
            assert.equal(matches, undefined);
            resolve();
          } catch (assertion) {
            reject(assertion);
          }
        });
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(callbacks, 1);
      assert.throws(
        () => glob.sync('**/*.txt', { cwd: dir, fs }),
        (error) => error === failure
      );
      const archive = path.join(dir, `failed-${code}.asar`);
      await assert.rejects(
        asar3.createPackageWithOptions(dir, archive, { globOptions: { fs } }),
        (error) => error === failure
      );
      assert.equal(
        nodeFs.existsSync(archive),
        false,
        'failed traversal must not publish a partial archive'
      );
      const rimraf3 = require(process.env.DEPENDENCY_COMPAT_ROOT ? 'rimraf3' : 'rimraf');
      const rimraf2 = process.env.DEPENDENCY_COMPAT_ROOT
        ? require('rimraf2')
        : createRequire(require.resolve('temp/package.json'))('rimraf');
      for (const rimraf of [rimraf2, rimraf3]) {
        await assert.rejects(
          promisify(rimraf)(path.join(dir, '**/*.txt'), { glob: { fs } }),
          (error) => error === failure
        );
        assert.throws(
          () => rimraf.sync(path.join(dir, '**/*.txt'), { glob: { fs } }),
          (error) => error === failure
        );
        assert.equal(
          await readFile(path.join(dir, 'a.txt'), 'utf8'),
          'lower',
          'failed traversal must not proceed with partial cleanup'
        );
      }
    }
  });
});

test('legacy traversal retains normal non-matches and rejects a non-directory cwd', async () => {
  await fixture(async (dir) => {
    const blocked = path.join(dir, 'nested');
    for (const code of ['ENOENT', 'ENOTDIR', 'ENOTSUP', 'ELOOP', 'ENAMETOOLONG', 'UNKNOWN']) {
      const failure = Object.assign(new Error(`injected ${code}`), { code, path: blocked });
      const fs = {
        readdir(directory, options, callback) {
          if (directory === blocked) return queueMicrotask(() => callback(failure));
          nodeFs.readdir(directory, options, callback);
        },
        readdirSync(directory, options) {
          if (directory === blocked) throw failure;
          return nodeFs.readdirSync(directory, options);
        },
      };
      const expected = ['a.txt', 'z.txt'];
      assert.deepEqual(await globAsync('**/*.txt', { cwd: dir, fs }), expected);
      assert.deepEqual(glob.sync('**/*.txt', { cwd: dir, fs }), expected);
    }
    const cwd = path.join(dir, 'a.txt');
    await assert.rejects(globAsync('*', { cwd }), { code: 'ENOTDIR' });
    assert.throws(() => glob.sync('*', { cwd }), { code: 'ENOTDIR' });
  });
});

// Exercise the upstream Windows path implementation on any host. All reads
// use a virtual filesystem, so neither drive letters nor UNC shares are accessed.
function windowsFixture(cwd) {
  function entry(name, directory = false) {
    return {
      name,
      isFile: () => !directory,
      isDirectory: () => directory,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    };
  }
  function readdirSync(directory) {
    const key = path.win32.relative(cwd, directory);
    if (key === '')
      return [entry('README.md', true), entry('README'), entry('a.txt'), entry('nested', true)];
    if (key === 'nested') return [entry('b.txt')];
    if (key === 'README.md') return [];
    throw Object.assign(new Error(`Unexpected fixture read: ${directory}`), { code: 'EIO' });
  }
  function lstatSync(file) {
    const relative = path.win32.relative(cwd, file);
    if (relative === '' || relative === 'nested' || relative === 'README.md')
      return entry(relative, true);
    if (['README', 'a.txt', String.raw`nested\b.txt`].includes(relative)) return entry(relative);
    throw Object.assign(new Error(`Unexpected fixture stat: ${file}`), { code: 'EIO' });
  }
  return {
    lstatSync,
    readdirSync,
    readdir(directory, _options, callback) {
      queueMicrotask(() => {
        let entries;
        try {
          entries = readdirSync(directory);
        } catch (error) {
          return callback(error);
        }
        callback(null, entries);
      });
    },
    promises: {
      readdir: async (directory) => readdirSync(directory),
      lstat: async (file) => lstatSync(file),
    },
  };
}

test('legacy Windows results retain forward slashes for drive, UNC, directory and absolute paths', async () => {
  for (const cwd of [
    String.raw`C:\fixture`,
    String.raw`c:\fixture`,
    String.raw`\\SerVer\Share\fixture`,
  ]) {
    const fs = windowsFixture(cwd);
    const options = { cwd, fs, platform: 'win32' };
    const prefix = cwd.replace(/\\/g, '/');
    for (const [pattern, extra, expected] of [
      ['**/*.txt', {}, ['a.txt', 'nested/b.txt']],
      ['**/*.txt', { absolute: true }, [`${prefix}/a.txt`, `${prefix}/nested/b.txt`]],
      [`${prefix}/**/*.txt`, {}, [`${prefix}/a.txt`, `${prefix}/nested/b.txt`]],
      [`${prefix}/**/*.txt`, { absolute: false }, ['a.txt', 'nested/b.txt']],
      [String.raw`nested\*.txt`, {}, ['nested/b.txt']],
      ['{README,README.*}', { mark: true }, ['README', 'README.md/']],
    ]) {
      assert.deepEqual(glob.sync(pattern, { ...options, ...extra }), expected);
      assert.deepEqual(await globAsync(pattern, { ...options, ...extra }), expected);
    }
    const readmes = await globAsync('{README,README.*}', { ...options, mark: true, nocase: true });
    // This is the retained read-package-json reader's directory exclusion.
    assert.deepEqual(
      readmes.filter((file) => !/\/$/.test(file)),
      ['README']
    );
  }
});

test(
  'POSIX result normalization preserves a literal backslash in a filename',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture(async (dir) => {
      const name = String.raw`literal\name.txt`;
      await writeFile(path.join(dir, name), 'literal');
      assert.ok(glob.sync('*.txt', { cwd: dir }).includes(name));
      assert.ok((await globAsync('*.txt', { cwd: dir })).includes(name));
    });
  }
);
