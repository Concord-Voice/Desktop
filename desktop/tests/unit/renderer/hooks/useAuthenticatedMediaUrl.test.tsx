import { act, renderHook, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server';
import { resetAllStores } from '../../../helpers/store-helpers';
import {
  invalidateAuthenticatedMediaUrl,
  useAuthenticatedMediaUrl,
} from '@/renderer/hooks/ui/useAuthenticatedMediaUrl';
import { useAuthStore } from '@/renderer/stores/auth/authStore';
import {
  getApiBase,
  resetRuntimeServerBase,
  setRuntimeServerBase,
} from '@/renderer/services/system/runtimeServerBase';

const mediaPath = '/api/v1/media/avatars/00000000-0000-4000-8000-000000000001';
const imageBytes = new Uint8Array([137, 80, 78, 71]);
const createObjectURL = vi.fn(() => 'blob:authenticated-avatar');
const revokeObjectURL = vi.fn();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

beforeEach(() => {
  resetAllStores();
  resetRuntimeServerBase();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
});

afterEach(() => {
  server.resetHandlers();
  resetRuntimeServerBase();
  delete (URL as Partial<typeof URL>).createObjectURL;
  delete (URL as Partial<typeof URL>).revokeObjectURL;
});

describe('useAuthenticatedMediaUrl', () => {
  it('aborts an identity response whose declared size exceeds the cap', async () => {
    const getReader = vi.fn();
    let signal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'Content-Type': 'image/png',
          'Content-Length': String(128 * 1024 * 1024 + 1),
        }),
        body: { getReader },
      } as unknown as Response;
    });
    try {
      useAuthStore.getState().setAccessToken('image-session');
      const view = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
      await waitFor(() => expect(signal?.aborted).toBe(true));
      expect(getReader).not.toHaveBeenCalled();
      expect(createObjectURL).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('aborts an identity request that does not finish by the deadline', async () => {
    let signal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      useAuthStore.getState().setAccessToken('image-session');
      const view = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
      await waitFor(() => expect(signal).toBeDefined());
      const timeout = timerSpy.mock.calls.find(([, delay]) => delay === 60_000)?.[0];
      expect(typeof timeout).toBe('function');
      act(() => (timeout as () => void)());
      expect(signal?.aborted).toBe(true);
      expect(createObjectURL).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      timerSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it('cancels an oversized identity stream even when its length is understated', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const reader = {
      read: vi.fn(async () => ({ done: false, value: chunk })),
      cancel: vi.fn(async () => undefined),
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({
        'Content-Type': 'image/png',
        'Content-Length': '1',
        'Content-Encoding': 'gzip',
      }),
      body: { getReader: () => reader },
      blob: vi.fn(async () => new Blob([imageBytes], { type: 'image/png' })),
    } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    try {
      useAuthStore.getState().setAccessToken('image-session');
      const view = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
      await waitFor(() => expect(reader.cancel).toHaveBeenCalledOnce());
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(view.result.current).toBeUndefined();
      view.unmount();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('fetches a canonical identity image with the active account and revokes it on logout', async () => {
    let authorization: string | null = null;
    server.use(
      http.get(`${getApiBase()}${mediaPath}`, ({ request }) => {
        authorization = request.headers.get('Authorization');
        return HttpResponse.arrayBuffer(imageBytes.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'image/png' },
        });
      })
    );
    useAuthStore.getState().setAccessToken('image-session');

    const { result } = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    await waitFor(() => expect(result.current).toBe('blob:authenticated-avatar'));
    expect(authorization).toBe('Bearer image-session');
    expect(createObjectURL).toHaveBeenCalledOnce();

    act(() => useAuthStore.getState().clearAccessToken());
    expect(result.current).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:authenticated-avatar');
  });

  it('shares one authenticated request and blob URL across mounted images', async () => {
    let requests = 0;
    server.use(
      http.get(`${getApiBase()}${mediaPath}`, () => {
        requests++;
        return HttpResponse.arrayBuffer(imageBytes.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'image/png' },
        });
      })
    );
    useAuthStore.getState().setAccessToken('image-session');

    const first = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    const second = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    await waitFor(() => {
      expect(first.result.current).toBe('blob:authenticated-avatar');
      expect(second.result.current).toBe('blob:authenticated-avatar');
    });
    expect(requests).toBe(1);
    expect(createObjectURL).toHaveBeenCalledOnce();

    first.unmount();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    second.unmount();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('refreshes mounted consumers when a fixed-key image is overwritten', async () => {
    let requests = 0;
    createObjectURL.mockReturnValueOnce('blob:old').mockReturnValueOnce('blob:new');
    server.use(
      http.get(`${getApiBase()}${mediaPath}`, () => {
        requests++;
        return HttpResponse.arrayBuffer(imageBytes.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'image/png' },
        });
      })
    );
    useAuthStore.getState().setAccessToken('image-session');
    const first = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    const second = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    await waitFor(() => expect(first.result.current).toBe('blob:old'));

    act(() => invalidateAuthenticatedMediaUrl(mediaPath));
    await waitFor(() => {
      expect(first.result.current).toBe('blob:new');
      expect(second.result.current).toBe('blob:new');
    });
    expect(requests).toBe(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:old');
  });

  it('retries a transient failure for mounted consumers', async () => {
    let requests = 0;
    server.use(
      http.get(`${getApiBase()}${mediaPath}`, () => {
        requests++;
        if (requests === 1) return new HttpResponse(null, { status: 503 });
        return HttpResponse.arrayBuffer(imageBytes.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'image/png' },
        });
      })
    );
    useAuthStore.getState().setAccessToken('image-session');
    const { result } = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    await waitFor(() => expect(result.current).toBe('blob:authenticated-avatar'));
    expect(requests).toBe(2);
  });

  it('resets the retry budget when all subscribers leave during backoff', async () => {
    let requests = 0;
    server.use(
      http.get(`${getApiBase()}${mediaPath}`, () => {
        requests++;
        if (requests <= 3) return new HttpResponse(null, { status: 503 });
        return HttpResponse.arrayBuffer(imageBytes.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'image/png' },
        });
      })
    );
    useAuthStore.getState().setAccessToken('image-session');
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const view = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
        await waitFor(() => expect(requests).toBe(attempt));
        await waitFor(() =>
          expect(timerSpy.mock.calls.some(([, delay]) => delay === 250 || delay === 500)).toBe(true)
        );
        view.unmount();
        timerSpy.mockClear();
      }
      const view = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
      await waitFor(() => expect(view.result.current).toBe('blob:authenticated-avatar'));
      expect(requests).toBe(4);
    } finally {
      timerSpy.mockRestore();
    }
  });

  it('resets the retry budget when the last subscriber abandons an in-flight retry', async () => {
    let requests = 0;
    server.use(
      http.get(`${getApiBase()}${mediaPath}`, async ({ request }) => {
        requests++;
        if (requests === 2 || requests === 4) {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve(), { once: true })
          );
          return new HttpResponse(null, { status: 503 });
        }
        if (requests <= 5) return new HttpResponse(null, { status: 503 });
        return HttpResponse.arrayBuffer(imageBytes.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'image/png' },
        });
      })
    );
    useAuthStore.getState().setAccessToken('image-session');

    for (const expected of [2, 4]) {
      const view = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
      await waitFor(() => expect(requests).toBe(expected));
      view.unmount();
    }
    const view = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    await waitFor(() => expect(view.result.current).toBe('blob:authenticated-avatar'));
    expect(requests).toBe(6);
  });

  it('reconnects mounted subscribers when a later mount replaces an exhausted request', async () => {
    let requests = 0;
    server.use(
      http.get(`${getApiBase()}${mediaPath}`, () => {
        requests++;
        if (requests <= 3) return new HttpResponse(null, { status: 503 });
        return HttpResponse.arrayBuffer(imageBytes.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'image/png' },
        });
      })
    );
    useAuthStore.getState().setAccessToken('image-session');
    const first = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    await waitFor(() => expect(requests).toBe(3));
    const second = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    await waitFor(() => {
      expect(first.result.current).toBe('blob:authenticated-avatar');
      expect(second.result.current).toBe('blob:authenticated-avatar');
    });
    expect(requests).toBe(4);
  });

  it('does not request managed media without a session or from another origin', () => {
    let requests = 0;
    server.use(
      http.get(`${getApiBase()}${mediaPath}`, () => {
        requests++;
        return HttpResponse.arrayBuffer(imageBytes.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'image/png' },
        });
      })
    );
    const anonymous = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    expect(anonymous.result.current).toBeUndefined();
    anonymous.unmount();
    useAuthStore.getState().setAccessToken('image-session');
    const wrongOrigin = renderHook(() =>
      useAuthenticatedMediaUrl(`https://other.example${mediaPath}`)
    );
    expect(wrongOrigin.result.current).toBeUndefined();
    expect(requests).toBe(0);
  });

  it('revokes a loaded image when the selected server changes', async () => {
    server.use(
      http.get(`${getApiBase()}${mediaPath}`, () =>
        HttpResponse.arrayBuffer(imageBytes.buffer as ArrayBuffer, {
          headers: { 'Content-Type': 'image/png' },
        })
      )
    );
    useAuthStore.getState().setAccessToken('image-session');
    const { result } = renderHook(() => useAuthenticatedMediaUrl(mediaPath));
    await waitFor(() => expect(result.current).toBe('blob:authenticated-avatar'));

    act(() => setRuntimeServerBase('https://another.example'));
    expect(result.current).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:authenticated-avatar');
  });

  it('keeps local crop previews without a session', () => {
    const { result } = renderHook(() => useAuthenticatedMediaUrl('data:image/png;base64,AAAA'));
    expect(result.current).toBe('data:image/png;base64,AAAA');
  });
});
