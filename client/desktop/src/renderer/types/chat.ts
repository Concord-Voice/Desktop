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
}

export interface Channel {
  id: string;
  server_id: string;
  name: string;
  description?: string;
  type: 'text' | 'voice';
  position: number;
  created_at: string;
  updated_at: string;
}

export interface SendMessageRequest {
  channel_id: string;
  content: string;
  is_encrypted: boolean;
}

export interface UpdateMessageRequest {
  content: string;
}

export interface GetMessagesResponse {
  messages: MessageWithUser[];
  count: number;
}
