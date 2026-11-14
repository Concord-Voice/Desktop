import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../../mocks/server';
import { eraseAccount, PrivacyApiError } from '@/renderer/api/privacy';

const request = {
  password: 'correct horse battery staple',
  mfa_code: '123456',
  confirmed_owned_server_ids: [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ],
};

const API_BASE = 'http://localhost:8080';

beforeAll(() => server.listen({ onUnhandledFrame: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('eraseAccount', () => {
  it('POSTs the proof and acknowledged sorted IDs, without a clientId, on 204', async () => {
    let received: unknown = 'not-set';
    server.use(
      http.post(`${API_BASE}/api/v1/privacy/erase-account`, async ({ request }) => {
        received = await request.json();
        return new HttpResponse(null, { status: 204 });
      })
    );

    await expect(eraseAccount(request)).resolves.toEqual({ kind: 'erased' });
    expect(received).toEqual(request);
  });

  it('throws PrivacyApiError on 502', async () => {
    server.use(
      http.post(
        `${API_BASE}/api/v1/privacy/erase-account`,
        () => new HttpResponse(null, { status: 502 })
      )
    );

    await expect(eraseAccount(request)).rejects.toBeInstanceOf(PrivacyApiError);
    await expect(eraseAccount(request)).rejects.toMatchObject({ status: 502, code: 'unknown' });
  });

  it('does not include clientId value in error message', async () => {
    server.use(
      http.post(
        `${API_BASE}/api/v1/privacy/erase-account`,
        () => new HttpResponse(null, { status: 500 })
      )
    );

    const sentinel = 'sentinel-value-frobozz-222';
    try {
      await eraseAccount({ ...request, password: sentinel });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrivacyApiError);
      expect((err as Error).message).not.toContain(sentinel);
    }
  });

  it('returns the email-confirmation preparation result without a secret', async () => {
    server.use(
      http.post(`${API_BASE}/api/v1/privacy/erase-account`, () =>
        HttpResponse.json(
          { status: 'email_confirmation_required', request_id: 'request-id', expires_in: 900 },
          { status: 202 }
        )
      )
    );
    await expect(eraseAccount(request)).resolves.toEqual({
      kind: 'email_confirmation_required', requestId: 'request-id', expiresIn: 900,
    });
  });

  it('types an owned-server confirmation drift response', async () => {
    server.use(
      http.post(`${API_BASE}/api/v1/privacy/erase-account`, () =>
        HttpResponse.json(
          { error_code: 'owned_server_confirmation_stale', required_owned_server_ids: ['server-id'] },
          { status: 409 }
        )
      )
    );
    await expect(eraseAccount(request)).rejects.toMatchObject({
      status: 409, code: 'owned_server_confirmation_stale', requiredOwnedServerIds: ['server-id'],
    });
  });
});
