import { describe, expect, it, vi } from 'vitest';
import { AttachmentTooLargeError } from '@/renderer/utils/runtime/boundedResponseBody';
import { MAX_IDENTITY_MEDIA_BYTES, readIdentityMedia } from '@/renderer/utils/ui/identityMedia';

describe('readIdentityMedia', () => {
  it('preserves a supported animated image at a premium upload size', async () => {
    const image = new Uint8Array(10 * 1024 * 1024);
    const response = new Response(image, { headers: { 'Content-Type': 'image/gif' } });
    const blob = await readIdentityMedia(response, 'image/gif');
    expect(blob.size).toBe(image.byteLength);
    expect(blob.type).toBe('image/gif');
  });

  it('rejects an oversized declared length before reading', async () => {
    const read = vi.fn();
    const response = {
      headers: new Headers({ 'Content-Length': String(MAX_IDENTITY_MEDIA_BYTES + 1) }),
      body: { getReader: () => ({ read }) },
    } as unknown as Response;
    await expect(readIdentityMedia(response, 'image/png')).rejects.toBeInstanceOf(
      AttachmentTooLargeError
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses a response without a stream rather than buffering it', async () => {
    const arrayBuffer = vi.fn();
    const response = { body: null, headers: new Headers(), arrayBuffer } as unknown as Response;
    await expect(readIdentityMedia(response, 'image/png')).rejects.toThrow(/no stream/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});
