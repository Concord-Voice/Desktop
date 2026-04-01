import { vi, describe, it, expect, beforeEach } from 'vitest';
import { pinMessage, unpinMessage, getChannelPins } from '@/renderer/services/pinService';

vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn(),
  safeJson: vi.fn(),
}));

import { apiFetch, safeJson } from '@/renderer/services/apiClient';

const mockApiFetch = apiFetch as ReturnType<typeof vi.fn>;
const mockSafeJson = safeJson as ReturnType<typeof vi.fn>;

describe('pinService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pinMessage', () => {
    it('sends POST to correct URL', async () => {
      mockApiFetch.mockResolvedValue({ ok: true });
      mockSafeJson.mockResolvedValue({
        message_id: 'msg-1',
        pinned_at: '2025-01-01',
        pinned_by: 'user-1',
      });

      await pinMessage('msg-1');

      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/messages/msg-1/pin', { method: 'POST' });
    });

    it('returns parsed response', async () => {
      const expected = { message_id: 'msg-1', pinned_at: '2025-01-01', pinned_by: 'user-1' };
      mockApiFetch.mockResolvedValue({ ok: true });
      mockSafeJson.mockResolvedValue(expected);

      const result = await pinMessage('msg-1');
      expect(result).toEqual(expected);
    });

    it('throws on error response', async () => {
      mockApiFetch.mockResolvedValue({ ok: false });
      mockSafeJson.mockResolvedValue({ error: 'Maximum of 50 pinned messages per channel' });

      await expect(pinMessage('msg-1')).rejects.toThrow(
        'Maximum of 50 pinned messages per channel'
      );
    });
  });

  describe('unpinMessage', () => {
    it('sends DELETE to correct URL', async () => {
      mockApiFetch.mockResolvedValue({ ok: true });
      mockSafeJson.mockResolvedValue({ message_id: 'msg-1' });

      await unpinMessage('msg-1');

      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/messages/msg-1/pin', { method: 'DELETE' });
    });

    it('throws on error response', async () => {
      mockApiFetch.mockResolvedValue({ ok: false });
      mockSafeJson.mockResolvedValue({ error: 'Failed to unpin' });

      await expect(unpinMessage('msg-1')).rejects.toThrow('Failed to unpin');
    });
  });

  describe('getChannelPins', () => {
    it('sends GET to correct URL', async () => {
      mockApiFetch.mockResolvedValue({ ok: true });
      mockSafeJson.mockResolvedValue({ pinned_messages: [], count: 0 });

      await getChannelPins('channel-1');

      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/channels/channel-1/pins');
    });

    it('returns pinned messages array', async () => {
      const pins = [{ id: 'msg-1', content: 'Pinned!' }];
      mockApiFetch.mockResolvedValue({ ok: true });
      mockSafeJson.mockResolvedValue({ pinned_messages: pins, count: 1 });

      const result = await getChannelPins('channel-1');
      expect(result).toEqual(pins);
    });

    it('throws on error response', async () => {
      mockApiFetch.mockResolvedValue({ ok: false });

      await expect(getChannelPins('channel-1')).rejects.toThrow('Failed to fetch pinned messages');
    });
  });
});
