import React, { useState, useRef, useEffect } from 'react';
import EmojiPicker, { EmojiClickData } from 'emoji-picker-react';
import { Hash, Volume2, Pin, Lock } from 'lucide-react';
import Modal from '../ui/Modal';
import LoadingSpinner from '../Auth/LoadingSpinner';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';
import { apiFetch } from '../../services/apiClient';
import { e2eeService } from '../../services/e2eeService';
import { Channel } from '../../types/chat';
import './CreateChannelModal.css';

interface CreateChannelModalProps {
  isOpen: boolean;
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

const CreateChannelModal: React.FC<CreateChannelModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [type, setType] = useState<'text' | 'voice' | 'bulletin'>('text');
  const [groupId, setGroupId] = useState<string | ''>('');
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const activeServerId = useServerStore((state) => state.activeServerId);
  const servers = useServerStore((state) => state.servers);
  const addChannel = useChannelStore((state) => state.addChannel);
  const channelGroups = useChannelStore((state) => state.channelGroups);
  const members = useMemberStore((state) => state.members);

  // Set initial E2EE toggle to the server's default
  useEffect(() => {
    if (activeServerId) {
      const server = servers.find((s) => s.id === activeServerId);
      setIsEncrypted(server?.e2ee_default ?? false);
    }
  }, [activeServerId, servers]);

  const emojiPickerRef = useRef<HTMLDivElement>(null);

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

  const resetForm = () => {
    setName('');
    setEmoji('');
    setType('text');
    setGroupId('');
    const server = servers.find((s) => s.id === activeServerId);
    setIsEncrypted(server?.e2ee_default ?? false);
    setErrors({});
    setIsSubmitting(false);
    setSuccessMessage(null);
    setShowEmojiPicker(false);
  };

  const handleClose = () => {
    if (!isSubmitting) {
      resetForm();
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm() || !activeServerId) {
      return;
    }

    setIsSubmitting(true);
    setErrors({});

    try {
      // If E2EE is enabled, generate channel key and wrap for all members
      let wrappedKeys: Record<string, string> | undefined;

      if (isEncrypted) {
        if (!e2eeService.isInitialized) {
          throw new Error('E2EE is not initialized. Please log out and log back in.');
        }

        // Fetch public keys for all server members
        const memberPublicKeys = new Map<string, string>();
        for (const member of members) {
          try {
            const pkRes = await apiFetch(`/api/v1/users/${member.user_id}/public-key`);
            if (pkRes.ok) {
              const pkData = await pkRes.json();
              memberPublicKeys.set(member.user_id, pkData.public_key);
            }
          } catch {
            // Skip members without public keys — they won't have E2EE access until key distribution
          }
        }

        if (memberPublicKeys.size === 0) {
          throw new Error('No member public keys available for E2EE channel creation');
        }

        // Generate CSK and wrap for each member
        const wrappedKeyMap = await e2eeService.createChannelKeys(memberPublicKeys);
        wrappedKeys = Object.fromEntries(wrappedKeyMap);
      }

      const response = await apiFetch('/api/v1/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_id: activeServerId,
          name: name.trim(),
          type,
          emoji: emoji.trim() || undefined,
          group_id: groupId || undefined,
          is_encrypted: isEncrypted,
          wrapped_keys: wrappedKeys,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create channel');
      }

      // Add channel to store
      addChannel(data.channel);

      // Show success message
      setSuccessMessage('Channel created successfully!');

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
        general: error instanceof Error ? error.message : 'Failed to create channel',
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
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Channel">
      <form onSubmit={handleSubmit} className="create-channel-form">
        {/* General Error */}
        {errors.general && <div className="channel-form-error-banner">{errors.general}</div>}

        {/* Success Message */}
        {successMessage && <div className="channel-form-success-banner">{successMessage}</div>}

        {/* Channel Name */}
        <div className="channel-form-group">
          <label htmlFor="channel-name" className="channel-form-label">
            Channel Name <span className="required">*</span>
          </label>
          <input
            id="channel-name"
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
          <label htmlFor="channel-emoji" className="channel-form-label">
            Channel Emoji (Optional)
          </label>
          <div className="emoji-input-wrapper" ref={emojiPickerRef}>
            <div className="emoji-input-container">
              <input
                id="channel-emoji"
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
            <label htmlFor="channel-group" className="channel-form-label">
              Channel Group
            </label>
            <select
              id="channel-group"
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
            <span className="channel-form-hint">Organize this channel into a group</span>
          </div>
        )}

        {/* E2EE Toggle */}
        <div className="channel-form-group">
          <label className="channel-form-label">End-to-End Encryption</label>
          <button
            type="button"
            className={`e2ee-toggle-option ${isEncrypted ? 'enabled' : 'disabled'}`}
            onClick={() => setIsEncrypted(!isEncrypted)}
            disabled={isSubmitting}
          >
            <span className="e2ee-toggle-icon">
              <Lock size={20} />
            </span>
            <div className="e2ee-toggle-info">
              <span className="e2ee-toggle-name">
                {isEncrypted ? 'Encryption Enabled' : 'Encryption Disabled'}
              </span>
              <span className="e2ee-toggle-desc">
                {isEncrypted
                  ? 'Messages will be encrypted end-to-end'
                  : 'Messages will not be encrypted'}
              </span>
            </div>
            <div className={`e2ee-toggle-switch ${isEncrypted ? 'on' : 'off'}`}>
              <div className="e2ee-toggle-knob" />
            </div>
          </button>
          <span className="channel-form-hint e2ee-warning">
            This cannot be changed after creation
          </span>
        </div>

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
            disabled={isSubmitting || !activeServerId}
          >
            {isSubmitting ? (
              <>
                <LoadingSpinner size="small" />
                <span>Creating...</span>
              </>
            ) : (
              'Create Channel'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default CreateChannelModal;
