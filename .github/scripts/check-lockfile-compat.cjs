// The lockfile refresh installs nothing. Use the SemVer implementation bundled
// with its pinned npm to classify ranges the same way as dependency-compat.test.mjs.
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

const [, , lockfile, npmRoot] = process.argv;
const { minVersion, validRange } = createRequire(path.join(npmRoot, "npm/package.json"))("semver");
const { packages } = JSON.parse(readFileSync(lockfile, "utf8"));
const lockDir = path.dirname(path.resolve(lockfile));

for (const [location, entry] of Object.entries(packages)) {
  if (!location.includes("node_modules/")) continue;
  const consumer = createRequire(path.join(lockDir, location, "package.json"));
  for (const [dependency, floor] of [["glob", 9], ["minimatch", 6]]) {
    // Match the installed-dependency check: only ordinary SemVer ranges
    // below the adapter threshold are legacy edges.
    const range = entry.dependencies?.[dependency];
    if (typeof range !== "string" || !range || !validRange(range)) continue;
    const minimum = minVersion(range);
    if (!minimum) {
      console.error("Unsatisfiable packaging dependency range: %j", { location, dependency, range });
      process.exitCode = 1;
      continue;
    }
    if (minimum.major >= floor) continue;

    const nearest = consumer.resolve.paths(dependency)
      .filter((dir) => dir.startsWith(lockDir + path.sep))
      .map((dir) => path.relative(lockDir, path.join(dir, dependency)).split(path.sep).join("/"))
      .find((candidate) => Object.hasOwn(packages, candidate));
    const resolved = packages[nearest];
    const expected = `@concordvoice/${dependency}-compat`;
    if (resolved?.name === expected &&
        resolved.resolved === `file:tools/${dependency}-compat` && !resolved.link) {
      continue;
    }

    const found = nearest ? `${nearest} (${resolved.resolved ?? "unresolved"})` : "no lockfile entry";
    console.error("Legacy adapter mismatch: %j", { consumer: `${location} -> ${dependency}`, expected, found });
    process.exitCode = 1;
  }
}
