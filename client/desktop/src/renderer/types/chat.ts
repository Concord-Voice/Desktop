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
