import React, { useState, useRef, useEffect } from 'react';
import EmojiPicker, { EmojiClickData } from 'emoji-picker-react';
import { Hash, Volume2, Pin } from 'lucide-react';
import Modal from '../ui/Modal';
import LoadingSpinner from '../Auth/LoadingSpinner';
import { useChannelStore } from '../../stores/channelStore';
import { AUDIO_QUALITY_TIERS } from '../../stores/voiceStore';
import type { AudioQualityTier } from '../../stores/voiceStore';
import { apiFetch } from '../../services/apiClient';
import { Channel } from '../../types/chat';
import './CreateChannelModal.css';

interface EditChannelModalProps {
  isOpen: boolean;
  channel: Channel;
  onClose: () => void;
  onSuccess?: (channel: Channel) => void;
}

interface FormErrors {
  name?: string;
  type?: string;
  general?: string;
}

const NAME_MIN = 3;
const NAME_MAX = 100;

const EditChannelModal: React.FC<EditChannelModalProps> = ({
  isOpen,
  channel,
  onClose,
  onSuccess,
}) => {
  const [name, setName] = useState(channel.name);
  const [emoji, setEmoji] = useState(channel.emoji || '');
  const [type, setType] = useState<'text' | 'voice' | 'bulletin'>(channel.type);
  const [groupId, setGroupId] = useState<string>(channel.group_id || '');
  const [audioQualityTier, setAudioQualityTier] = useState<string | null>(channel.audio_quality_tier ?? null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const updateChannel = useChannelStore((state) => state.updateChannel);
  const channelGroups = useChannelStore((state) => state.channelGroups);

  const emojiPickerRef = useRef<HTMLDivElement>(null);

  // Reset form when channel changes
  useEffect(() => {
    setName(channel.name);
    setEmoji(channel.emoji || '');
    setType(channel.type);
    setGroupId(channel.group_id || '');
    setAudioQualityTier(channel.audio_quality_tier ?? null);
    setErrors({});
    setSuccessMessage(null);
    setShowEmojiPicker(false);
  }, [channel]);

  // Close emoji picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setShowEmojiPicker(false);
      }
    };

    if (showEmojiPicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showEmojiPicker]);

  const handleClose = () => {
    if (!isSubmitting) {
      setErrors({});
      setSuccessMessage(null);
      setShowEmojiPicker(false);
      onClose();
    }
  };

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};
    const trimmed = name.trim();

    if (!trimmed) {
      newErrors.name = 'Channel name is required';
    } else if (trimmed.length < NAME_MIN) {
      newErrors.name = `Channel name must be at least ${NAME_MIN} characters`;
    } else if (trimmed.length > NAME_MAX) {
      newErrors.name = `Channel name must be at most ${NAME_MAX} characters`;
    }

    if (!type) {
      newErrors.type = 'Channel type is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const hasChanges = (): boolean => {
    return (
      name.trim() !== channel.name ||
      (emoji.trim() || '') !== (channel.emoji || '') ||
      type !== channel.type ||
      groupId !== (channel.group_id || '') ||
      audioQualityTier !== (channel.audio_quality_tier ?? null)
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    if (!hasChanges()) {
      handleClose();
      return;
    }

    setIsSubmitting(true);
    setErrors({});

    try {
      const response = await apiFetch(`/api/v1/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          type,
          emoji: emoji.trim() || null,
          group_id: groupId || null,
          audio_quality_tier: audioQualityTier || null,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to update channel');
      }

      // Update channel in store
      updateChannel(channel.id, data.channel);

      // Show success message
      setSuccessMessage('Channel updated successfully!');

      // Call onSuccess callback if provided
      if (onSuccess) {
        onSuccess(data.channel);
      }

      // Close modal after short delay
      setTimeout(() => {
        handleClose();
      }, 1000);
    } catch (error) {
      setErrors({
        general: error instanceof Error ? error.message : 'Failed to update channel',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEmojiClick = (emojiData: EmojiClickData) => {
    setEmoji(emojiData.emoji);
    setShowEmojiPicker(false);
  };

  const getChannelTypeIcon = (channelType: 'text' | 'voice' | 'bulletin') => {
    switch (channelType) {
      case 'text':
        return <Hash size={20} />;
      case 'voice':
        return <Volume2 size={20} />;
      case 'bulletin':
        return <Pin size={20} />;
      default:
        return <Hash size={20} />;
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Edit Channel">
      <form onSubmit={handleSubmit} className="create-channel-form">
        {/* General Error */}
        {errors.general && <div className="channel-form-error-banner">{errors.general}</div>}

        {/* Success Message */}
        {successMessage && <div className="channel-form-success-banner">{successMessage}</div>}

        {/* Channel Name */}
        <div className="channel-form-group">
          <label htmlFor="edit-channel-name" className="channel-form-label">
            Channel Name <span className="required">*</span>
          </label>
          <input
            id="edit-channel-name"
            type="text"
            className={`channel-form-input ${errors.name ? 'error' : ''}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="general-chat"
            maxLength={NAME_MAX}
            disabled={isSubmitting}
            autoFocus
          />
          {errors.name && <span className="channel-form-error">{errors.name}</span>}
          <span className="channel-form-hint">
            {name.length}/{NAME_MAX} characters
          </span>
        </div>

        {/* Channel Emoji (Optional) */}
        <div className="channel-form-group">
          <label htmlFor="edit-channel-emoji" className="channel-form-label">
            Channel Emoji (Optional)
          </label>
          <div className="emoji-input-wrapper" ref={emojiPickerRef}>
            <div className="emoji-input-container">
              <input
                id="edit-channel-emoji"
                type="text"
                className="channel-form-input"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="😀 (optional)"
                maxLength={2}
                disabled={isSubmitting}
              />
              <button
                type="button"
                className="emoji-picker-button"
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                disabled={isSubmitting}
                title="Pick an emoji"
              >
                😀
              </button>
            </div>
            {showEmojiPicker && (
              <div className="emoji-picker-container">
                <EmojiPicker onEmojiClick={handleEmojiClick} />
              </div>
            )}
          </div>
          <span className="channel-form-hint">Add a custom emoji to represent this channel</span>
        </div>

        {/* Channel Type */}
        <div className="channel-form-group">
          <label className="channel-form-label">
            Channel Type <span className="required">*</span>
          </label>
          <div className="channel-type-selector">
            <button
              type="button"
              className={`channel-type-option ${type === 'text' ? 'selected' : ''}`}
              onClick={() => setType('text')}
              disabled={isSubmitting}
            >
              <span className="channel-type-icon">{getChannelTypeIcon('text')}</span>
              <div className="channel-type-info">
                <span className="channel-type-name">Text</span>
                <span className="channel-type-desc">Send messages, images, and files</span>
              </div>
            </button>

            <button
              type="button"
              className={`channel-type-option ${type === 'voice' ? 'selected' : ''}`}
              onClick={() => setType('voice')}
              disabled={isSubmitting}
            >
              <span className="channel-type-icon">{getChannelTypeIcon('voice')}</span>
              <div className="channel-type-info">
                <span className="channel-type-name">Voice</span>
                <span className="channel-type-desc">Voice and video conversations</span>
              </div>
            </button>

            <button
              type="button"
              className={`channel-type-option ${type === 'bulletin' ? 'selected' : ''}`}
              onClick={() => setType('bulletin')}
              disabled={isSubmitting}
            >
              <span className="channel-type-icon">{getChannelTypeIcon('bulletin')}</span>
              <div className="channel-type-info">
                <span className="channel-type-name">Bulletin</span>
                <span className="channel-type-desc">Important announcements only</span>
              </div>
            </button>
          </div>
          {errors.type && <span className="channel-form-error">{errors.type}</span>}
        </div>

        {/* Channel Group */}
        {channelGroups.length > 0 && (
          <div className="channel-form-group">
            <label htmlFor="edit-channel-group" className="channel-form-label">
              Channel Group
            </label>
            <select
              id="edit-channel-group"
              className="channel-form-input"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              disabled={isSubmitting}
            >
              <option value="">Uncategorized</option>
              {channelGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <span className="channel-form-hint">Move this channel to a different group</span>
          </div>
        )}

        {/* Audio Quality Tier (voice channels only) */}
        {type === 'voice' && (
          <div className="channel-form-group">
            <label className="channel-form-label">Audio Quality</label>
            <span className="channel-form-hint" style={{ marginBottom: 8 }}>
              Override personal quality settings for all users in this channel.
            </span>
            <div className="channel-type-selector">
              <button
                type="button"
                className={`channel-type-option ${audioQualityTier === null ? 'selected' : ''}`}
                onClick={() => setAudioQualityTier(null)}
                disabled={isSubmitting}
              >
                <div className="channel-type-info">
                  <span className="channel-type-name">Personal</span>
                  <span className="channel-type-desc">Each user uses their own quality setting</span>
                </div>
              </button>
              {(Object.keys(AUDIO_QUALITY_TIERS) as AudioQualityTier[]).map((tier) => {
                const config = AUDIO_QUALITY_TIERS[tier];
                return (
                  <button
                    key={tier}
                    type="button"
                    className={`channel-type-option ${audioQualityTier === tier ? 'selected' : ''}`}
                    onClick={() => setAudioQualityTier(tier)}
                    disabled={isSubmitting}
                  >
                    <div className="channel-type-info">
                      <span className="channel-type-name">{config.label}</span>
                      <span className="channel-type-desc">{config.description}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Submit Button */}
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={isSubmitting || !hasChanges()}
          >
            {isSubmitting ? (
              <>
                <LoadingSpinner size="small" />
                <span>Saving...</span>
              </>
            ) : (
              'Save Changes'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default EditChannelModal;
