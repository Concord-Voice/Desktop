import type { MessageWithStatus, Channel, ReactionSummary } from '../../src/renderer/types/chat';
import type { ServerWithRole } from '../../src/renderer/types/server';

// --- Users ---

export const mockUser = {
  id: 'user-1',
  email: 'testuser@concord.chat',
  username: 'testuser',
  display_name: 'Test User',
  bio: null,
  avatar_url: null,
  header_image_url: null,
  links: [],
  email_verified: false,
  age_verified: true,
  e2ee_preference: false,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

export const mockUser2 = {
  ...mockUser,
  id: 'user-2',
  email: 'testuser2@concord.chat',
  username: 'testuser2',
  display_name: 'Test User 2',
};

// --- Servers ---

export const mockServer: ServerWithRole = {
  id: 'server-1',
  name: 'Test Server',
  icon_url: undefined,
  owner_id: 'user-1',
  e2ee_default: false,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  role: 'owner',
  member_count: 2,
  online_count: 1,
};

export const mockServer2: ServerWithRole = {
  ...mockServer,
  id: 'server-2',
  name: 'Second Server',
  owner_id: 'user-2',
  role: 'member',
};

// --- Channels ---

export const mockChannel: Channel = {
  id: 'channel-1',
  server_id: 'server-1',
  name: 'general',
  type: 'text',
  is_encrypted: false,
  position: 0,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

export const mockEncryptedChannel: Channel = {
  ...mockChannel,
  id: 'channel-2',
  name: 'encrypted-chat',
  is_encrypted: true,
  position: 1,
};

// --- Messages ---

export const mockMessage: MessageWithStatus = {
  id: 'msg-1',
  channel_id: 'channel-1',
  user_id: 'user-1',
  content: 'Hello, world!',
  username: 'testuser',
  display_name: 'Test User',
  is_encrypted: false,
  status: 'delivered',
  created_at: '2025-01-01T12:00:00Z',
  updated_at: '2025-01-01T12:00:00Z',
};

export const mockMessage2: MessageWithStatus = {
  ...mockMessage,
  id: 'msg-2',
  user_id: 'user-2',
  username: 'testuser2',
  display_name: 'Test User 2',
  content: 'Hi there!',
  created_at: '2025-01-01T12:01:00Z',
  updated_at: '2025-01-01T12:01:00Z',
};

export const mockPendingMessage: MessageWithStatus = {
  ...mockMessage,
  id: 'msg-pending',
  status: 'pending',
  clientMessageId: 'client-msg-1',
  content: 'Sending...',
};

// --- Reactions (for #169) ---

export const mockReaction: ReactionSummary = {
  emoji: '👍',
  count: 2,
  users: [
    { user_id: 'user-1', username: 'testuser', display_name: 'Test User' },
    { user_id: 'user-2', username: 'testuser2', display_name: 'Test User 2' },
  ],
  me: true,
};

export const mockReaction2: ReactionSummary = {
  emoji: '❤️',
  count: 1,
  users: [{ user_id: 'user-2', username: 'testuser2', display_name: 'Test User 2' }],
  me: false,
};

// --- Reply Messages (for #170) ---

export const mockReplyMessage: MessageWithStatus = {
  ...mockMessage,
  id: 'msg-reply',
  content: 'This is a reply',
  reply_to_id: 'msg-1',
  replied_to: {
    id: 'msg-1',
    user_id: 'user-1',
    username: 'testuser',
    display_name: 'Test User',
    content: 'Hello, world!',
    is_encrypted: false,
  },
  created_at: '2025-01-01T12:02:00Z',
  updated_at: '2025-01-01T12:02:00Z',
};

// --- Pinned Messages (for #171) ---

export const mockPinnedMessage: MessageWithStatus = {
  ...mockMessage,
  id: 'msg-pinned',
  content: 'Important announcement',
  pinned_at: '2025-01-01T13:00:00Z',
  pinned_by: 'user-1',
  created_at: '2025-01-01T12:00:00Z',
  updated_at: '2025-01-01T12:00:00Z',
};

// --- Members ---

export const mockMember = {
  user_id: 'user-1',
  server_id: 'server-1',
  username: 'testuser',
  display_name: 'Test User',
  avatar_url: null,
  role: 'owner' as const,
  joined_at: '2025-01-01T00:00:00Z',
};

export const mockMember2 = {
  ...mockMember,
  user_id: 'user-2',
  username: 'testuser2',
  display_name: 'Test User 2',
  role: 'member' as const,
};

// --- Auth ---

export const mockTokens = {
  accessToken: 'mock-access-token',
  refreshToken: 'mock-refresh-token',
};

export const mockE2EEKeys = {
  wrapped_private_key: 'mock-wrapped-private-key',
  key_derivation_salt: 'mock-salt',
  key_version: 1,
};
