export interface Message {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  is_encrypted: boolean;
  edited_at?: string;
  created_at: string;
  updated_at: string;
}

export interface MessageWithUser extends Message {
  username: string;
  display_name?: string;
  avatar_url?: string;
}

/**
 * Extended message type with delivery status tracking
 * Used for local message state management
 */
export interface MessageWithStatus extends MessageWithUser {
  status?: 'pending' | 'sent' | 'delivered' | 'failed';
  clientMessageId?: string; // Temporary ID before server assigns permanent ID
  error?: string; // Error message if status is 'failed'
  decryptFailed?: boolean; // True if E2EE decryption failed (never show raw ciphertext)
  pendingKeys?: boolean; // True if channel key not yet distributed (waiting for key delivery)
}

export interface Channel {
  id: string;
  server_id: string;
  name: string;
  description?: string;
  type: 'text' | 'voice' | 'bulletin';
  emoji?: string; // Optional custom emoji set by admins
  is_encrypted: boolean;
  audio_quality_tier?: string | null; // Admin override: voice/standard/high/hifi/studio or null (personal)
  group_id?: string | null; // FK to channel_groups; null = uncategorized
  linked_voice_channel_id?: string | null; // Non-null = hidden text chat attached to a voice channel
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ChannelGroup {
  id: string;
  server_id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface UpdateMessageRequest {
  content: string;
}

export interface GetMessagesResponse {
  messages: MessageWithUser[];
  count: number;
}
