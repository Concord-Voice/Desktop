/** Bound decoded authentication JSON and keep the request deadline through body consumption. */
export const AUTH_RESPONSE_MAX_BYTES = 1024 * 1024;
export const AUTH_REQUEST_TIMEOUT_MS = 30_000;

export function authRequestSignal(flowSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([flowSignal, AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)]);
}

function growAuthBuffer(bytes: Uint8Array, used: number, needed: number): Uint8Array {
  if (needed <= bytes.length) return bytes;
  const grown = new Uint8Array(
    Math.min(AUTH_RESPONSE_MAX_BYTES, Math.max(bytes.length * 2, needed))
  );
  grown.set(bytes.subarray(0, used));
  return grown;
}

export async function readAuthJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const body = response.body;
  const declared = response.headers.get('content-length');
  const length = declared === null || declared.trim() === '' ? Number.NaN : Number(declared);
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (
    signal.aborted ||
    ((!encoding || encoding === 'identity') &&
      Number.isFinite(length) &&
      length > AUTH_RESPONSE_MAX_BYTES)
  ) {
    if (body) void body.cancel().catch(() => undefined);
    throw new Error('authentication response unavailable');
  }
  if (!body) throw new Error('authentication response body unavailable');

  const reader = body.getReader();
  let bytes: Uint8Array = new Uint8Array(16 * 1024);
  let total = 0;
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw new Error('authentication response cancelled');
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('authentication response cancelled');
      if (done) break;
      if (value.byteLength > AUTH_RESPONSE_MAX_BYTES - total)
        throw new Error('authentication response too large');
      bytes = growAuthBuffer(bytes, total, total + value.byteLength);
      bytes.set(value, total);
      total += value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, total))) as unknown;
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
