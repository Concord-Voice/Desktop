// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AUTH_RESPONSE_MAX_BYTES, readAuthJson } from '@/main/authResponse';

const liveSignal = () => new AbortController().signal;

describe('bounded authentication response JSON', () => {
  it('parses valid JSON at the exact byte limit', async () => {
    const payload = `{"v":"${'x'.repeat(AUTH_RESPONSE_MAX_BYTES - 8)}"}`;
    expect(Buffer.byteLength(payload)).toBe(AUTH_RESPONSE_MAX_BYTES);
    const result = await readAuthJson(new Response(payload), liveSignal());
    expect((result as { v: string }).v).toHaveLength(AUTH_RESPONSE_MAX_BYTES - 8);
  });

  it('does not treat an encoded Content-Length as the decoded byte count', async () => {
    const payload = `{"v":"${'x'.repeat(AUTH_RESPONSE_MAX_BYTES - 8)}"}`;
    const response = new Response(payload, {
      headers: {
        'Content-Encoding': 'gzip',
        'Content-Length': String(AUTH_RESPONSE_MAX_BYTES + 173),
      },
    });
    const result = await readAuthJson(response, liveSignal());
    expect((result as { v: string }).v).toHaveLength(AUTH_RESPONSE_MAX_BYTES - 8);
  });

  it('rejects an oversized declared length and cancels the stream', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, {
      headers: { 'Content-Length': String(AUTH_RESPONSE_MAX_BYTES + 1) },
    });
    await expect(readAuthJson(response, liveSignal())).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, '1'])(
    'rejects excess streamed bytes with Content-Length %s',
    async (declared) => {
      const cancel = vi.fn();
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new Uint8Array(AUTH_RESPONSE_MAX_BYTES + 1));
          }
        },
        cancel,
      });
      const response = new Response(
        body,
        declared ? { headers: { 'Content-Length': declared } } : undefined
      );
      await expect(readAuthJson(response, liveSignal())).rejects.toThrow();
      expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it('cancels a stalled body immediately on abort', async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const pending = readAuthJson(
      new Response(new ReadableStream<Uint8Array>({ cancel })),
      controller.signal
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('handles many tiny chunks without retaining an array per chunk', async () => {
    const payload = new TextEncoder().encode(`{"v":"${'x'.repeat(200000)}"}`);
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === payload.length) controller.close();
        else controller.enqueue(payload.subarray(index, ++index));
      },
    });
    const result = await readAuthJson(new Response(body), liveSignal());
    expect((result as { v: string }).v).toHaveLength(200000);
  });

  it('settles an aborted read even if the underlying cancel promise never resolves', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) });
    const pending = readAuthJson(new Response(body), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('fails closed on missing streams or malformed JSON', async () => {
    await expect(readAuthJson(new Response(null), liveSignal())).rejects.toThrow();
    await expect(readAuthJson(new Response('{bad'), liveSignal())).rejects.toThrow();
  });
});
