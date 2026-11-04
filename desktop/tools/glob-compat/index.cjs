'use strict';

const modern = require('glob-modern');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

// This is the subset used by ASAR 3, electron-installer-common and rimraf 2/3.
// A new consumer/option must be reviewed, not silently treated as compatible.
const forwarded = new Set([
  'cwd',
  'root',
  'dot',
  'mark',
  'nodir',
  'nobrace',
  'noglobstar',
  'noext',
  'nocase',
  'matchBase',
  'follow',
  'ignore',
  'realpath',
  'absolute',
  'stat',
  'fs',
  'platform',
  'windowsPathsNoEscape',
  'allowWindowsEscape',
  'signal',
]);
const legacy = new Set(['nosort', 'silent', 'strict']);

function optionsFor(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('glob-compat options must be an object');
  }
  const result = {
    // glob 7 used false on every platform; glob 14 defaults true on macOS.
    nocase: false,
    // Preserve glob 7's treatment of path.join() patterns on Windows.
    windowsPathsNoEscape: (options.platform ?? process.platform) === 'win32',
  };
  for (const [key, value] of Object.entries(options)) {
    if (forwarded.has(key)) result[key] = value;
    else if (!legacy.has(key)) throw new TypeError(`glob-compat does not support option ${key}`);
  }
  if (options.strict === false) {
    throw new TypeError('glob-compat does not support suppressing filesystem errors');
  }
  return result;
}

// glob 7's strict default propagates unexpected readdir errors. path-scurry
// deliberately catches them and returns [], so throwing inside fs alone is not
// enough. Remember each traversal's first failure before path-scurry catches it,
// then reject the whole result instead of returning a partially scanned tree.
function checkedTraversal(options) {
  const custom = options.fs ?? {};
  const promises = custom.promises ?? nodeFs.promises;
  const path = (options.platform ?? process.platform) === 'win32' ? nodePath.win32 : nodePath.posix;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let firstError;
  function record(error, directory) {
    if (!error || firstError) return;
    switch (error.code) {
      case 'ENOTDIR':
      case 'ENOTSUP':
        if (path.resolve(directory) === cwd) {
          firstError = Object.assign(new Error(`${error.code} invalid cwd ${options.cwd ?? cwd}`), {
            code: error.code,
            path: options.cwd ?? cwd,
          });
        }
        return;
      case 'ENOENT':
      case 'ELOOP':
      case 'ENAMETOOLONG':
      case 'UNKNOWN':
        return; // glob 7 treats these as ordinary non-matches.
      default:
        firstError = error;
    }
  }
  function recordCwdStat(error, directory, stat) {
    if (path.resolve(directory) !== cwd) return;
    if (error) record(error, directory);
    else if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      // glob 14 stats cwd before reading it and skips non-directories. glob 7
      // reaches readdir instead, where its invalid-cwd error is observable.
      record(Object.assign(new Error('cwd is not a directory'), { code: 'ENOTDIR' }), directory);
    }
  }
  const fs = {
    ...custom,
    lstatSync(directory, opts) {
      try {
        const stat = (custom.lstatSync ?? nodeFs.lstatSync).call(custom, directory, opts);
        recordCwdStat(null, directory, stat);
        return stat;
      } catch (error) {
        recordCwdStat(error, directory);
        throw error;
      }
    },
    readdir(directory, opts, callback) {
      let completed = false;
      const done = (error, entries) => {
        if (completed) return;
        completed = true;
        record(error, directory);
        callback(error, entries);
      };
      try {
        (custom.readdir ?? nodeFs.readdir).call(custom, directory, opts, done);
      } catch (error) {
        if (completed) throw error;
        done(error);
      }
    },
    readdirSync(directory, opts) {
      try {
        return (custom.readdirSync ?? nodeFs.readdirSync).call(custom, directory, opts);
      } catch (error) {
        record(error, directory);
        throw error;
      }
    },
    promises: {
      ...custom.promises,
      async lstat(directory, opts) {
        try {
          const stat = await (promises.lstat ?? nodeFs.promises.lstat).call(
            promises,
            directory,
            opts
          );
          recordCwdStat(null, directory, stat);
          return stat;
        } catch (error) {
          recordCwdStat(error, directory);
          throw error;
        }
      },
      async readdir(directory, opts) {
        try {
          return await (promises.readdir ?? nodeFs.promises.readdir).call(
            promises,
            directory,
            opts
          );
        } catch (error) {
          record(error, directory);
          throw error;
        }
      },
    },
  };
  return {
    options: { ...options, fs },
    throwIfError() {
      if (firstError) throw firstError;
    },
  };
}

function validatePattern(pattern) {
  if (typeof pattern !== 'string') throw new TypeError('glob-compat pattern must be a string');
}

function finish(matches, options, pattern) {
  // glob 7 exposes forward slashes, including directory marks and absolute
  // drive/UNC paths. Preserve literal backslashes on POSIX filesystems.
  if ((options.platform ?? process.platform) === 'win32') {
    const inputRoot = nodePath.win32
      .parse(nodePath.win32.isAbsolute(pattern) ? pattern : (options.cwd ?? process.cwd()))
      .root.replace(/\\/g, '/');
    matches = matches.map((match) => {
      const outputRoot = nodePath.win32.parse(match).root.replace(/\\/g, '/');
      const normalized = match.replace(/\\/g, '/');
      // path-scurry uppercases drive/UNC roots. Retain the caller's spelling,
      // as glob 7 does, without altering case-sensitive path components.
      return outputRoot && outputRoot.toLowerCase() === inputRoot.toLowerCase()
        ? inputRoot + normalized.slice(outputRoot.length)
        : normalized;
    });
  }
  return options.nosort ? matches : matches.sort((a, b) => a.localeCompare(b, 'en'));
}

function glob(pattern, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  options ??= {};
  if (typeof callback !== 'function') {
    throw new TypeError('glob-compat requires a callback; event-emitter Glob is not supported');
  }
  // Catch synchronous validation failures and report them through the callback.
  // Separate fulfillment/rejection handlers prevent a callback exception from
  // causing a second invocation of the callback.
  let traversal;
  Promise.resolve()
    .then(() => {
      validatePattern(pattern);
      traversal = checkedTraversal(optionsFor(options));
      return modern.glob(pattern, traversal.options);
    })
    .then((matches) => {
      traversal.throwIfError();
      return finish(matches, options, pattern);
    })
    .then(
      (matches) => callback(null, matches),
      (error) => callback(error)
    );
}

function sync(pattern, options = {}) {
  validatePattern(pattern);
  const traversal = checkedTraversal(optionsFor(options));
  const matches = modern.globSync(pattern, traversal.options);
  traversal.throwIfError();
  return finish(matches, options, pattern);
}

function hasMagic(pattern, options = {}) {
  validatePattern(pattern);
  return modern.hasMagic(pattern, { ...optionsFor(options), magicalBraces: true });
}

module.exports = glob;
module.exports.glob = glob;
module.exports.sync = sync;
module.exports.hasMagic = hasMagic;
