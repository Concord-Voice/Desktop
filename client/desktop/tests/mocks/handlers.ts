import { http, HttpResponse } from 'msw';
import { mockUser, mockServer, mockChannel, mockMessage, mockMember, mockMember2, mockE2EEKeys } from './fixtures';

const API_BASE = 'http://localhost:8080';

export const handlers = [
  // --- Auth ---
  http.post(`${API_BASE}/api/v1/auth/register`, () => {
    return HttpResponse.json({
      access_token: 'mock-access-token',
      expires_in: 900,
      remember_me: true,
      user: {
        id: mockUser.id,
        username: mockUser.username,
        e2ee_preference: false,
      },
    }, { status: 201 });
  }),

  http.post(`${API_BASE}/api/v1/auth/login`, () => {
    return HttpResponse.json({
      access_token: 'mock-access-token',
      expires_in: 900,
      remember_me: true,
      user: mockUser,
      e2ee_keys: mockE2EEKeys,
    });
  }),

  http.post(`${API_BASE}/api/v1/auth/refresh`, () => {
    return HttpResponse.json({
      access_token: 'mock-new-access-token',
      expires_in: 900,
    });
  }),

  http.post(`${API_BASE}/api/v1/auth/logout`, () => {
    return HttpResponse.json({ message: 'Logged out successfully' });
  }),

  // --- Users ---
  http.get(`${API_BASE}/api/v1/users/me`, () => {
    return HttpResponse.json({ user: mockUser });
  }),

  http.patch(`${API_BASE}/api/v1/users/me`, () => {
    return HttpResponse.json({ user: mockUser });
  }),

  http.get(`${API_BASE}/api/v1/users/me/keys`, () => {
    return HttpResponse.json(mockE2EEKeys);
  }),

  http.get(`${API_BASE}/api/v1/users/me/preferences`, () => {
    return HttpResponse.json({ encrypted_blob: null, version: 0 });
  }),

  http.put(`${API_BASE}/api/v1/users/me/preferences`, () => {
    return HttpResponse.json({ version: 1 });
  }),

  // --- Servers ---
  http.get(`${API_BASE}/api/v1/servers`, () => {
    return HttpResponse.json({ servers: [mockServer] });
  }),

  http.post(`${API_BASE}/api/v1/servers`, () => {
    return HttpResponse.json({ server: mockServer, role: 'owner' }, { status: 201 });
  }),

  http.get(`${API_BASE}/api/v1/servers/:id`, () => {
    return HttpResponse.json({ server: mockServer, role: 'owner' });
  }),

  http.get(`${API_BASE}/api/v1/servers/unread-status`, () => {
    return HttpResponse.json({ server_ids: [] });
  }),

  http.get(`${API_BASE}/api/v1/servers/:id/unread`, () => {
    return HttpResponse.json({ channels: [] });
  }),

  // --- Channels ---
  http.get(`${API_BASE}/api/v1/servers/:id/channels`, () => {
    return HttpResponse.json({ channels: [mockChannel] });
  }),

  http.post(`${API_BASE}/api/v1/channels`, () => {
    return HttpResponse.json({ channel: mockChannel }, { status: 201 });
  }),

  http.get(`${API_BASE}/api/v1/channels/:id/messages`, () => {
    return HttpResponse.json({ messages: [mockMessage], count: 1 });
  }),

  // --- Messages ---
  http.post(`${API_BASE}/api/v1/messages`, () => {
    return HttpResponse.json({ message: mockMessage }, { status: 201 });
  }),

  http.patch(`${API_BASE}/api/v1/messages/:id`, () => {
    return HttpResponse.json({ message: { ...mockMessage, content: 'edited' } });
  }),

  http.delete(`${API_BASE}/api/v1/messages/:id`, () => {
    return HttpResponse.json({ message: 'Message deleted' });
  }),

  // --- Members ---
  http.get(`${API_BASE}/api/v1/servers/:id/members`, () => {
    return HttpResponse.json({ members: [mockMember, mockMember2] });
  }),

  // --- Invites ---
  http.post(`${API_BASE}/api/v1/servers/:id/invites`, () => {
    return HttpResponse.json({
      invite: {
        id: 'invite-1',
        server_id: 'server-1',
        code: 'TESTCODE',
        max_uses: 1,
        use_count: 0,
        expires_at: null,
        is_revoked: false,
        created_at: '2025-01-01T00:00:00Z',
      },
    }, { status: 201 });
  }),

  http.get(`${API_BASE}/api/v1/servers/:id/invites`, () => {
    return HttpResponse.json({ invites: [] });
  }),

  // --- E2EE ---
  http.get(`${API_BASE}/api/v1/e2ee/pending-keys`, () => {
    return HttpResponse.json({ requests: [] });
  }),

  http.get(`${API_BASE}/api/v1/channels/:id/keys`, () => {
    return HttpResponse.json({ wrapped_key: 'mock-key', key_version: 1 });
  }),
];
