import { apiFetch, safeJson } from './apiClient';
import type { MessageWithUser } from '../types/chat';

export interface PinResponse {
  message_id: string;
  pinned_at: string;
  pinned_by: string;
  already_pinned?: boolean;
}

export interface UnpinResponse {
  message_id: string;
  already_unpinned?: boolean;
}

export interface GetPinsResponse {
  pinned_messages: MessageWithUser[];
  count: number;
}

export async function pinMessage(messageId: string): Promise<PinResponse> {
  const res = await apiFetch(`/api/v1/messages/${messageId}/pin`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await safeJson<{ error: string }>(res);
    throw new Error(err.error || 'Failed to pin message');
  }
  return safeJson<PinResponse>(res);
}

export async function unpinMessage(messageId: string): Promise<UnpinResponse> {
  const res = await apiFetch(`/api/v1/messages/${messageId}/pin`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await safeJson<{ error: string }>(res);
    throw new Error(err.error || 'Failed to unpin message');
  }
  return safeJson<UnpinResponse>(res);
}

export async function getChannelPins(channelId: string): Promise<MessageWithUser[]> {
  const res = await apiFetch(`/api/v1/channels/${channelId}/pins`);
  if (!res.ok) {
    throw new Error('Failed to fetch pinned messages');
  }
  const data = await safeJson<GetPinsResponse>(res);
  return data.pinned_messages;
}
