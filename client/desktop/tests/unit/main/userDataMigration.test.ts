// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Mocks ────────────────────────────────────────────────────────────────

const mockGetPath = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'userDataMigration-test-'));
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('userDataMigration', () => {
  let tmpDir: string;
  let parentDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    parentDir = path.join(tmpDir, 'AppData');
    fs.mkdirSync(parentDir, { recursive: true });

    // app.getPath('userData') returns the NEW path (<parent>/ConcordVoice)
    mockGetPath.mockImplementation((key: string) => {
      if (key === 'userData') return path.join(parentDir, 'ConcordVoice');
      return tmpDir;
    });

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  async function loadModule() {
    vi.resetModules();
    return import('../../../src/main/userDataMigration');
  }

  describe('migrateUserData', () => {
    it('renames old dir to new dir when old exists and new does not', async () => {
      const oldDir = path.join(parentDir, 'Concord Voice');
      fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'hw-accel.json'), '{"enabled":true}');
      fs.writeFileSync(path.join(oldDir, 'update-prefs.json'), '{"allowPrerelease":true}');

      const { migrateUserData } = await loadModule();
      migrateUserData();

      const newDir = path.join(parentDir, 'ConcordVoice');
      // Old dir should be gone
      expect(fs.existsSync(oldDir)).toBe(false);
      // New dir should exist with contents preserved
      expect(fs.existsSync(newDir)).toBe(true);
      expect(fs.existsSync(path.join(newDir, 'hw-accel.json'))).toBe(true);
      expect(fs.existsSync(path.join(newDir, 'update-prefs.json'))).toBe(true);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('[migration] Renamed userData directory')
      );
    });

    it('does nothing when old dir does not exist', async () => {
      const { migrateUserData } = await loadModule();
      migrateUserData();

      // Neither dir should exist (no migration attempted)
      expect(fs.existsSync(path.join(parentDir, 'Concord Voice'))).toBe(false);
      expect(fs.existsSync(path.join(parentDir, 'ConcordVoice'))).toBe(false);
      expect(console.log).not.toHaveBeenCalled();
    });

    it('does nothing when new dir already exists (already migrated)', async () => {
      const oldDir = path.join(parentDir, 'Concord Voice');
      const newDir = path.join(parentDir, 'ConcordVoice');
      fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'old-data.json'), 'old');
      fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(path.join(newDir, 'new-data.json'), 'new');

      const { migrateUserData } = await loadModule();
      migrateUserData();

      // Both dirs should still exist, neither modified
      expect(fs.existsSync(path.join(oldDir, 'old-data.json'))).toBe(true);
      expect(fs.existsSync(path.join(newDir, 'new-data.json'))).toBe(true);
      expect(console.log).not.toHaveBeenCalled();
    });

    it('skips migration when old path is a file not a directory', async () => {
      const oldPath = path.join(parentDir, 'Concord Voice');
      fs.writeFileSync(oldPath, 'not a directory');

      const { migrateUserData } = await loadModule();
      migrateUserData();

      // File should remain untouched
      expect(fs.existsSync(oldPath)).toBe(true);
      expect(fs.readFileSync(oldPath, 'utf-8')).toBe('not a directory');
      expect(console.log).not.toHaveBeenCalled();
    });

    it('logs warning and continues when rename fails', async () => {
      const oldDir = path.join(parentDir, 'Concord Voice');
      fs.mkdirSync(oldDir, { recursive: true });

      // Mock renameSync to throw
      vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const { migrateUserData } = await loadModule();
      migrateUserData();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('[migration] Failed to rename userData directory')
      );
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));

      // Restore
      vi.mocked(fs.renameSync).mockRestore();
    });

    it('is idempotent (calling twice is safe)', async () => {
      const oldDir = path.join(parentDir, 'Concord Voice');
      fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'data.json'), 'test');

      const { migrateUserData } = await loadModule();

      // First call: migrates
      migrateUserData();
      const newDir = path.join(parentDir, 'ConcordVoice');
      expect(fs.existsSync(newDir)).toBe(true);

      // Second call: no-op (old dir gone, new dir exists)
      migrateUserData();
      expect(fs.existsSync(newDir)).toBe(true);
      expect(fs.readFileSync(path.join(newDir, 'data.json'), 'utf-8')).toBe('test');
    });
  });

  describe('resolveUserDataParent', () => {
    it('returns the parent directory of userData path', async () => {
      const { resolveUserDataParent } = await loadModule();
      const parent = resolveUserDataParent();
      expect(parent).toBe(parentDir);
    });
  });
});
