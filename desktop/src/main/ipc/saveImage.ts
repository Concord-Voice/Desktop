import { dialog, type BaseWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { registerIpc } from './registry';
import { SAVE_IMAGE_MAX_BYTES } from '../../shared/saveImage';

/**
 * image:saveAs IPC handler — writes a decrypted image attachment to a
 * user-chosen path via a native Save-As dialog (#1729).
 *
 * An E2EE attachment is decrypted only in the renderer (a `blob:` URL), so the
 * native "Save Image As…" context item cannot reach it — the bytes are passed
 * in over IPC. This handler is the main-process layer the renderer cannot
 * bypass, mirroring `openExternal`'s defense-in-depth posture:
 *   1. sender admission: the foreground connection's bound primary main frame only
 *      (`app-global-mutate`, #86), at a permitted frame URL (`isPermittedFrameUrl`),
 *   2. payload-shape + size validation,
 *   3. filename sanitisation (basename only — no path traversal),
 *   4. the destination path is chosen by the user in `showSaveDialog`, never by
 *      the renderer.
 */

type WindowProvider = () => BaseWindow | null;

export interface SaveImageResult {
  ok: boolean;
  canceled?: boolean;
  reason?: 'untrusted-sender' | 'invalid-args' | 'too-large' | 'write-failed';
}

/** Reduce a renderer-supplied name to a safe bare filename (no path, no reserved chars). */
export function safeImageName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) return 'image';
  const cleaned = basename(name)
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : 'image';
}

export function registerSaveImageHandler(windowProvider: WindowProvider): void {
  // #86: `app-global-mutate`. The dialog is modal over the shared window and the path the
  // user picks receives the SENDER's bytes, so a background connection must not raise it
  // over the foreground one. Written here as well as in CHANNEL_CLASSES so registerIpc
  // throws if the table is widened alone. Every refusal, `not-foreground` included, gets
  // the existing `untrusted-sender` result (the preload contract's closed reason set).
  registerIpc(
    'image:saveAs',
    'app-global-mutate',
    async (_sender, _event, bytes: unknown, suggestedName: unknown): Promise<SaveImageResult> => {
      // Electron structured-clones ArrayBuffer / TypedArrays across the IPC boundary.
      if (!(bytes instanceof ArrayBuffer) && !ArrayBuffer.isView(bytes)) {
        return { ok: false, reason: 'invalid-args' };
      }
      if (bytes.byteLength === 0) return { ok: false, reason: 'invalid-args' };
      if (bytes.byteLength > SAVE_IMAGE_MAX_BYTES) return { ok: false, reason: 'too-large' };
      const buf =
        bytes instanceof ArrayBuffer
          ? Buffer.from(bytes)
          : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      const win = windowProvider();
      const options = { defaultPath: safeImageName(suggestedName) };
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return { ok: true, canceled: true };
      }

      try {
        await writeFile(result.filePath, buf);
        return { ok: true };
      } catch {
        // Write failure (permissions, disk full, path vanished) — structured,
        // never leak the OS error or the path into the result.
        return { ok: false, reason: 'write-failed' };
      }
    },
    {
      refusal: (): Promise<SaveImageResult> =>
        Promise.resolve({ ok: false, reason: 'untrusted-sender' }),
    }
  );
}
