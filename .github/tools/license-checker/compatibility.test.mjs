import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import test from "node:test";

const exec = promisify(execFile);
const checker =
  process.env.LICENSE_CHECKER_BIN ||
  fileURLToPath(
    new URL(
      "./node_modules/license-checker/bin/license-checker",
      import.meta.url,
    ),
  );

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "concord-license-compat-"));
  async function pkg(relative, manifest, files = {}) {
    const dir = path.join(root, relative);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify(manifest));
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
  }
  await pkg("", {
    name: "first-party-fixture",
    version: "1.0.0",
    private: true,
    dependencies: {
      plain: "1.0.0",
      alias: "npm:canonical@2.0.0",
      inferred: "1.0.0",
      dual: "1.0.0",
    },
    optionalDependencies: {
      optional: "1.0.0",
      monorepo: "1.0.0",
      absent: "1.0.0",
    },
    devDependencies: { development: "1.0.0" },
  });
  await pkg("node_modules/plain", {
    name: "plain",
    version: "1.0.0",
    license: "MIT",
    repository: "https://example.invalid/plain",
  });
  await pkg("node_modules/alias", {
    name: "canonical",
    version: "2.0.0",
    license: "Apache-2.0",
  });
  await pkg("node_modules/dual", {
    name: "dual",
    version: "1.0.0",
    license: "(MIT OR Apache-2.0)",
  });
  await pkg("node_modules/monorepo", {
    name: "monorepo",
    version: "1.0.0",
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/example/monorepo/tree/main/packages/example",
      directory: "packages/example",
    },
  });
  await pkg("node_modules/optional", {
    name: "optional",
    version: "1.0.0",
    license: "ISC",
  });
  await pkg("node_modules/development", {
    name: "development",
    version: "1.0.0",
    license: "GPL-3.0-only",
  });
  await pkg(
    "node_modules/inferred",
    { name: "inferred", version: "1.0.0" },
    {
      "README.md": "# Fixture\n",
      LICENSE:
        'MIT License\n\nCopyright (c) 2026 Fixture\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n',
    },
  );
  return { root, pkg };
}

async function run(root, ...args) {
  return exec(
    process.execPath,
    [checker, "--production", "--excludePrivatePackages", ...args],
    {
      cwd: root,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );
}

test("retains production, alias, optional and private-package attribution semantics", async () => {
  const { root } = await fixture();
  try {
    const { stdout } = await run(root, "--json");
    const data = JSON.parse(stdout);
    assert.deepEqual(Object.keys(data).sort(), [
      "canonical@2.0.0",
      "dual@1.0.0",
      "inferred@1.0.0",
      "monorepo@1.0.0",
      "optional@1.0.0",
      "plain@1.0.0",
    ]);
    assert.equal(data["plain@1.0.0"].licenses, "MIT");
    assert.equal(data["canonical@2.0.0"].licenses, "Apache-2.0");
    assert.equal(data["dual@1.0.0"].licenses, "(MIT OR Apache-2.0)");
    assert.match(data["inferred@1.0.0"].licenses, /^MIT\*?$/);
    assert.equal(
      data["monorepo@1.0.0"].repository,
      "https://github.com/example/monorepo/tree/main/packages/example",
    );
    const csv = (await run(root, "--csv")).stdout;
    assert.match(csv, /^"module name","license","repository"/);
    assert.match(csv, /"canonical@2.0.0","Apache-2.0"/);
    assert.match(csv, /"plain@1.0.0","MIT","https:\/\/example.invalid\/plain"/);
    assert.doesNotMatch(csv, /first-party-fixture|development@/);
    await run(root, "--onlyAllow", "MIT;Apache-2.0;ISC", "--summary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("license policy still rejects disallowed production dependencies", async () => {
  const { root, pkg } = await fixture();
  try {
    await pkg("node_modules/plain", {
      name: "plain",
      version: "1.0.0",
      license: "GPL-3.0-only",
    });
    await assert.rejects(
      run(root, "--onlyAllow", "MIT;Apache-2.0;ISC", "--summary"),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /not permitted by the --onlyAllow flag/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("license reader uses the current packed callback adapter", async () => {
  // Baseline CLI runs intentionally exercise the unmodified historical tool.
  if (process.env.LICENSE_CHECKER_BIN) return;
  const require = createRequire(import.meta.url);
  const reader = createRequire(
    require.resolve("read-package-json/package.json"),
  );
  const adapter = reader("glob/package.json");
  assert.equal(adapter.name, "@concordvoice/glob-compat");
  const installed = path.dirname(reader.resolve("glob/package.json"));
  const source = fileURLToPath(
    new URL("../../../desktop/tools/glob-compat/", import.meta.url),
  );
  for (const file of ["index.cjs", "package.json"]) {
    assert.equal(
      await readFile(path.join(installed, file), "utf8"),
      await readFile(path.join(source, file), "utf8"),
    );
  }
});

test("metadata reader excludes a README.md directory before choosing README", async () => {
  if (process.env.LICENSE_CHECKER_BIN) return;
  const { root } = await fixture();
  try {
    await mkdir(path.join(root, "README.md"));
    await writeFile(path.join(root, "README"), "The real README file\n");
    const require = createRequire(import.meta.url);
    const readPackage = promisify(require("read-package-json"));
    const data = await readPackage(path.join(root, "package.json"));
    assert.equal(data.readme, "The real README file\n");
    assert.equal(data.readmeFilename, "README");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
