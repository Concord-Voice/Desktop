// The lockfile refresh installs nothing. Use the SemVer implementation bundled
// with its pinned npm to classify ranges the same way as dependency-compat.test.mjs.
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const [, , lockfile, npmRoot] = process.argv;
const { minVersion } = createRequire(path.join(npmRoot, "npm/package.json"))("semver");
const { packages } = JSON.parse(readFileSync(lockfile, "utf8"));
const lockDir = path.dirname(path.resolve(lockfile));

for (const [location, entry] of Object.entries(packages)) {
  if (!location.includes("node_modules/")) continue;
  const consumer = createRequire(path.join(lockDir, location, "package.json"));
  for (const [dependency, floor] of [["glob", 9], ["minimatch", 6]]) {
    const range = entry.dependencies?.[dependency];
    if (!range) continue;
    let minimum;
    try {
      minimum = minVersion(range);
    } catch {
      // Non-SemVer dependencies are outside the legacy registry range overrides.
      continue;
    }
    if (!minimum || minimum.major >= floor) continue;

    const nearest = consumer.resolve.paths(dependency)
      .map((dir) => path.relative(lockDir, path.join(dir, dependency)).split(path.sep).join("/"))
      .find((candidate) => Object.hasOwn(packages, candidate));
    const resolved = packages[nearest];
    const expected = `@concordvoice/${dependency}-compat`;
    if (resolved?.name === expected && resolved.resolved === `file:tools/${dependency}-compat`) {
      continue;
    }

    const found = nearest ? `${nearest} (${resolved.resolved ?? "unresolved"})` : "no lockfile entry";
    console.error(`::error::${location} -> ${dependency}: expected ${expected}; got ${found}`);
    process.exitCode = 1;
  }
}
