import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * Old userData directory name (productName had a space: "Concord Voice").
 * New name is "ConcordVoice" (spaceless, set in package.json productName).
 *
 * This migration runs once on first launch after the rename to preserve
 * auth tokens (safeStorage), E2EE keys, update preferences, and hw-accel
 * settings for existing alpha users.
 *
 * Must be called before app.whenReady() — Electron resolves and creates
 * the userData directory during initialization.
 */
const OLD_DIR_NAME = 'Concord Voice';

/**
 * Resolve the parent directory that contains the userData folder.
 * On each platform this is:
 *   Windows: %APPDATA%
 *   macOS:   ~/Library/Application Support
 *   Linux:   ~/.config  (or $XDG_CONFIG_HOME)
 */
export function resolveUserDataParent(): string {
  // app.getPath('userData') returns <parent>/<productName>.
  // We want just the parent.
  return path.dirname(app.getPath('userData'));
}

/**
 * Migrate the old "Concord Voice" userData directory to "ConcordVoice".
 *
 * Rules:
 * - Only migrates if old dir exists AND new dir does NOT exist
 * - If both exist, leaves both untouched (don't overwrite)
 * - If rename fails, logs a warning and continues (Electron creates fresh userData)
 * - Safe to call multiple times (idempotent)
 */
export function migrateUserData(): void {
  const parent = resolveUserDataParent();
  const oldPath = path.join(parent, OLD_DIR_NAME);
  const newPath = app.getPath('userData'); // Already points to "ConcordVoice"

  // Nothing to migrate
  if (!fs.existsSync(oldPath)) return;

  // Verify old path is actually a directory (not a stray file)
  try {
    const stat = fs.statSync(oldPath);
    if (!stat.isDirectory()) return;
  } catch {
    return;
  }

  // New dir already exists — don't overwrite (already migrated or fresh install)
  if (fs.existsSync(newPath)) return;

  try {
    fs.renameSync(oldPath, newPath);
    console.debug(
      `[migration] Renamed userData directory: "${OLD_DIR_NAME}" → "${path.basename(newPath)}"`
    );
  } catch (err: unknown) {
    // Rename can fail on cross-device moves or permission issues.
    // Log and continue — Electron will create a fresh userData directory.
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(`[migration] Failed to rename userData directory: ${errorMessage}`);
  }
}
