'use strict';

// Legacy minimatch treats native Windows backslashes as separators unless
// allowWindowsEscape is explicitly enabled. Apply that default to every helper
// and Minimatch constructor through upstream's own defaults implementation.
const modern = require('minimatch-modern').defaults(
  process.platform === 'win32' ? { allowWindowsEscape: false } : {}
);

// ASAR 3 and dir-compare call the default export. filelist and eslintrc use
// its helpers/Minimatch class. All matching remains in patched upstream code.
// In particular, do not restore makeRe() or turn Matcher objects back into
// regular expressions. glob 7's consumers use glob-compat instead.
function minimatch(path, pattern, options) {
  return modern(path, pattern, options);
}

Object.assign(minimatch, modern);
module.exports = minimatch;
// Explicit assignments also expose the named exports to Node's CJS lexer.
module.exports.minimatch = minimatch;
module.exports.Minimatch = modern.Minimatch;
module.exports.GLOBSTAR = modern.GLOBSTAR;
module.exports.filter = modern.filter;
module.exports.match = modern.match;
module.exports.braceExpand = modern.braceExpand;
module.exports.escape = modern.escape;
module.exports.unescape = modern.unescape;
module.exports.defaults = modern.defaults;
module.exports.sep = modern.sep;
