// @vitest-environment node
/**
 * Unit tests for the forensic build-tag IPC surface (#920 §5.13).
 *
 * Covers:
 *  - Happy path: buildtag.json present with `{tag: "..."}` → returns the tag.
 *  - Missing-injection path: buildtag.json absent → returns 'unknown'.
 *  - Malformed paths: corrupt JSON / wrong shape → returns 'unknown'.
 *  - Memoization: repeated calls do not re-read the file, including the
 *    error-path cases (a transient failure pins 'unknown' for the process
 *    lifetime).
 *  - Path resolution: both packaged-build branch (process.resourcesPath set)
 *    and dev/test branch (cwd fallback) of `resolveBuildtagPath`.
 *  - Grep audit (regression guard): no renderer-context source references
 *    VITE_BUILD_TAG or __BUILD_TAG__. The threat-model concern is that a
 *    compromised renderer dependency could exfiltrate the tag via
 *    import.meta.env.VITE_BUILD_TAG if any renderer source ever opted in.
 *
 * The grep audit uses Node `fs.readdirSync` (recursive) + string search
 * rather than shelling out to `grep`, so the test is portable to any
 * Vitest-supported environment. Earlier drafts used `execSync('grep ...')`,
 * which works on macOS/Linux but would fail on a Windows runner with no
 * GNU/BSD `grep` on PATH (per pr-review-toolkit:silent-failure-hunter and
 * pr-review-toolkit:pr-test-analyzer audit on PR #982).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      readFileSync: vi.fn(),
    },
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe('getBuildTag', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // Reset the module-level cache between cases by re-importing fresh.
    vi.resetModules();
  });

  it('returns the injected value when buildtag.json is present and well-formed', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tag: 'pr-smoke-25592711033' }));
    const { getBuildTag } = await import('../../../src/main/buildInfo');
    expect(getBuildTag()).toBe('pr-smoke-25592711033');
  });

  it("returns 'unknown' when buildtag.json is absent (dev / local build)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { getBuildTag } = await import('../../../src/main/buildInfo');
    expect(getBuildTag()).toBe('unknown');
  });

  it("returns 'unknown' when buildtag.json is malformed JSON", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json {');
    const { getBuildTag } = await import('../../../src/main/buildInfo');
    expect(getBuildTag()).toBe('unknown');
  });

  it("returns 'unknown' when buildtag.json has an unexpected shape", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ wrong: 'shape' }));
    const { getBuildTag } = await import('../../../src/main/buildInfo');
    expect(getBuildTag()).toBe('unknown');
  });

  it("returns 'unknown' when buildtag.json has a non-string tag", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tag: 42 }));
    const { getBuildTag } = await import('../../../src/main/buildInfo');
    expect(getBuildTag()).toBe('unknown');
  });

  it('caches the value across repeated calls (no re-read)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tag: 'first-tag' }));
    const { getBuildTag } = await import('../../../src/main/buildInfo');
    expect(getBuildTag()).toBe('first-tag');
    // Underlying source changes — cached result should win.
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tag: 'second-tag' }));
    expect(getBuildTag()).toBe('first-tag');
    expect(vi.mocked(fs.readFileSync).mock.calls.length).toBe(1);
  });

  it("caches 'unknown' from missing-file path across repeated calls", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { getBuildTag } = await import('../../../src/main/buildInfo');
    expect(getBuildTag()).toBe('unknown');
    // Even if the file appears between calls, the cached 'unknown' wins.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tag: 'late-arrival' }));
    expect(getBuildTag()).toBe('unknown');
    expect(vi.mocked(fs.readFileSync).mock.calls.length).toBe(0);
  });

  it("caches 'unknown' from malformed-JSON path across repeated calls", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json {');
    const { getBuildTag } = await import('../../../src/main/buildInfo');
    expect(getBuildTag()).toBe('unknown');
    // Subsequent valid content does not unstick the cache.
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tag: 'recovered' }));
    expect(getBuildTag()).toBe('unknown');
    expect(vi.mocked(fs.readFileSync).mock.calls.length).toBe(1);
  });

  it("caches 'unknown' from thrown-error path across repeated calls", async () => {
    // Simulate a transient EACCES — the catch block in getBuildTag logs and
    // returns 'unknown', and that result must be memoized to avoid retrying.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    // Silence the expected console.warn for this test only. `try/finally`
    // guarantees `warnSpy.mockRestore()` runs even if an `expect` assertion
    // throws below, so the spy can't leak into subsequent tests in this
    // describe block.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { getBuildTag } = await import('../../../src/main/buildInfo');
      expect(getBuildTag()).toBe('unknown');
      expect(warnSpy).toHaveBeenCalledOnce();
      // Subsequent call must not re-read.
      expect(getBuildTag()).toBe('unknown');
      expect(vi.mocked(fs.readFileSync).mock.calls.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('resolveBuildtagPath', () => {
  it('uses process.resourcesPath when provided (packaged-build branch)', async () => {
    const { resolveBuildtagPath } = await import('../../../src/main/buildInfo');
    const result = resolveBuildtagPath('/Applications/Foo.app/Resources', '/should/be/ignored');
    expect(result).toBe(path.join('/Applications/Foo.app/Resources', 'buildtag.json'));
  });

  it('falls back to cwd when resourcesPath is undefined (dev/test branch)', async () => {
    const { resolveBuildtagPath } = await import('../../../src/main/buildInfo');
    const result = resolveBuildtagPath(undefined, '/some/cwd');
    expect(result).toBe(path.resolve('/some/cwd', 'buildtag.json'));
  });

  it('falls back to cwd when resourcesPath is empty string', async () => {
    const { resolveBuildtagPath } = await import('../../../src/main/buildInfo');
    const result = resolveBuildtagPath('', '/some/cwd');
    expect(result).toBe(path.resolve('/some/cwd', 'buildtag.json'));
  });
});

describe('renderer-context grep audit (regression guard)', () => {
  // Hardcoded paths derived from __dirname at compile time — never user input.
  const rendererDir = path.resolve(__dirname, '../../../src/renderer');
  const RENDERER_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);

  // The `vi.mock('node:fs')` at the top of this file replaces `existsSync`
  // and `readFileSync` for the getBuildTag describe's fixtures. The grep
  // audit needs to read the REAL renderer source tree, so we resolve the
  // unmocked fs via vi.importActual once and use it throughout.
  let realFs: typeof import('node:fs');

  beforeAll(async () => {
    realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  });

  /**
   * Recursively walk a directory and return all file paths matching the
   * given extensions. Pure Node fs — no shell out, portable to any
   * Vitest-supported environment (including Windows runners).
   */
  function* walkRenderer(root: string): Generator<string> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = realFs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        yield* walkRenderer(fullPath);
      } else if (entry.isFile() && RENDERER_EXTENSIONS.has(path.extname(entry.name))) {
        yield fullPath;
      }
    }
  }

  /** Scan renderer sources for `needle`, return list of `path:line` hits. */
  function findHitsInRenderer(needle: string): string[] {
    const hits: string[] = [];
    for (const filePath of walkRenderer(rendererDir)) {
      const content = realFs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (line.includes(needle)) {
          hits.push(`${filePath}:${idx + 1}`);
        }
      });
    }
    return hits;
  }

  it('no production renderer source references CONCORD_BUILD_TAG (current name)', () => {
    // The forensic build tag MUST stay main-process-only. Any renderer
    // reference (e.g., `import.meta.env.CONCORD_BUILD_TAG`) would expose
    // it to compromised renderer dependencies via the bundled JS surface.
    // Note: CONCORD_BUILD_TAG is non-VITE-prefixed by design, so Vite's
    // dotenv loader won't pick it up either — this assertion is
    // defense-in-depth, not the primary barrier.
    const hits = findHitsInRenderer('CONCORD_BUILD_TAG');
    expect(hits).toEqual([]);
  });

  it('no production renderer source references VITE_BUILD_TAG (legacy regression guard)', () => {
    // Before the post-Copilot-review rename on PR #982, the env var was
    // `VITE_BUILD_TAG`. That name made the value reachable via Vite's
    // `import.meta.env.VITE_*` mechanism. The rename to `CONCORD_BUILD_TAG`
    // closes the Vite-env exposure path; this regression test catches any
    // future revert to the legacy name from renderer code.
    const hits = findHitsInRenderer('VITE_BUILD_TAG');
    expect(hits).toEqual([]);
  });

  it('no production renderer source references __BUILD_TAG__', () => {
    const hits = findHitsInRenderer('__BUILD_TAG__');
    expect(hits).toEqual([]);
  });
});
