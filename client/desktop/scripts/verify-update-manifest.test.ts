// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyManifest } from './verify-update-manifest.mjs';

function sha512Base64(buf: Buffer): string {
  return createHash('sha512').update(buf).digest('base64');
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'verify-manifest-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('verifyManifest', () => {
  it('returns ok: true when all artifacts match', () => {
    const contents = Buffer.from('fake installer bytes');
    writeFileSync(path.join(dir, 'Concord-Setup.exe'), contents);
    const manifest = `version: 0.1.21\nfiles:\n  - url: Concord-Setup.exe\n    sha512: ${sha512Base64(contents)}\n    size: ${contents.length}\npath: Concord-Setup.exe\nsha512: ${sha512Base64(contents)}\nreleaseDate: '2026-04-15T00:00:00.000Z'\n`;
    const manifestPath = path.join(dir, 'latest.yml');
    writeFileSync(manifestPath, manifest);

    const result = verifyManifest(manifestPath);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('returns ok: false when an artifact hash mismatches', () => {
    const contents = Buffer.from('fake installer bytes');
    writeFileSync(path.join(dir, 'Concord-Setup.exe'), contents);
    const manifest = `version: 0.1.21\nfiles:\n  - url: Concord-Setup.exe\n    sha512: AAAAAAwrongHashAAAAAA==\n    size: ${contents.length}\npath: Concord-Setup.exe\nsha512: AAAAAAwrongHashAAAAAA==\nreleaseDate: '2026-04-15T00:00:00.000Z'\n`;
    const manifestPath = path.join(dir, 'latest.yml');
    writeFileSync(manifestPath, manifest);

    const result = verifyManifest(manifestPath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /sha512 mismatch/.test(e))).toBe(true);
  });

  it('returns ok: false when a referenced artifact is missing on disk', () => {
    const manifest = `version: 0.1.21\nfiles:\n  - url: Missing-Setup.exe\n    sha512: AAAA==\n    size: 10\npath: Missing-Setup.exe\nsha512: AAAA==\nreleaseDate: '2026-04-15T00:00:00.000Z'\n`;
    const manifestPath = path.join(dir, 'latest.yml');
    writeFileSync(manifestPath, manifest);

    const result = verifyManifest(manifestPath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /missing artifact|ENOENT/.test(e))).toBe(true);
  });

  it('returns ok: false on malformed YAML', () => {
    const manifestPath = path.join(dir, 'latest.yml');
    writeFileSync(manifestPath, 'not: valid: yaml: [');
    const result = verifyManifest(manifestPath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /parse|yaml/i.test(e))).toBe(true);
  });

  it('returns ok: false on manifest with no files array', () => {
    const manifestPath = path.join(dir, 'latest.yml');
    writeFileSync(manifestPath, `version: 0.1.21\nreleaseDate: '2026-04-15'\n`);
    const result = verifyManifest(manifestPath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /no files/.test(e))).toBe(true);
  });

  it('finds artifacts in nested subdirectories (CI layout)', () => {
    const contents = Buffer.from('nested installer bytes');
    const subdir = path.join(dir, 'concord-voice-windows-x64-v0.1.21');
    mkdirSync(subdir);
    writeFileSync(path.join(subdir, 'Concord-Setup.exe'), contents);
    const manifest = `version: 0.1.21\nfiles:\n  - url: Concord-Setup.exe\n    sha512: ${sha512Base64(contents)}\n    size: ${contents.length}\npath: Concord-Setup.exe\nsha512: ${sha512Base64(contents)}\nreleaseDate: '2026-04-15T00:00:00.000Z'\n`;
    const manifestPath = path.join(dir, 'latest.yml');
    writeFileSync(manifestPath, manifest);
    const result = verifyManifest(manifestPath);
    expect(result.ok).toBe(true);
  });

  it('rejects ambiguous artifact names (multiple subdirs contain the same basename)', () => {
    const contents = Buffer.from('fake');
    for (const sub of ['a', 'b']) {
      const subdir = path.join(dir, sub);
      mkdirSync(subdir);
      writeFileSync(path.join(subdir, 'Dup-Setup.exe'), contents);
    }
    const manifest = `version: 0.1.21\nfiles:\n  - url: Dup-Setup.exe\n    sha512: ${sha512Base64(contents)}\n    size: ${contents.length}\npath: Dup-Setup.exe\nsha512: ${sha512Base64(contents)}\nreleaseDate: '2026-04-15T00:00:00.000Z'\n`;
    const manifestPath = path.join(dir, 'latest.yml');
    writeFileSync(manifestPath, manifest);
    const result = verifyManifest(manifestPath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /ambiguous/.test(e))).toBe(true);
  });
});
