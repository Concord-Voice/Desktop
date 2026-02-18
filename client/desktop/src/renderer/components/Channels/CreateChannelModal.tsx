import React, { useState } from 'react';
import Modal from '../ui/Modal';
import LoadingSpinner from '../Auth/LoadingSpinner';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
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

const CreateChannelModal: React.FC<CreateChannelModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [name, setName] = useState('');
  const [type, setType] = useState<'text' | 'voice' | 'bulletin'>('text');
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const accessToken = useAuthStore((state) => state.accessToken);
  const activeServerId = useServerStore((state) => state.activeServerId);
  const addChannel = useChannelStore((state) => state.addChannel);

  const resetForm = () => {
    setName('');
    setType('text');
    setErrors({});
    setIsSubmitting(false);
    setSuccessMessage(null);
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

    if (!validateForm() || !accessToken || !activeServerId) {
      return;
    }

    setIsSubmitting(true);
    setErrors({});

    try {
      const response = await fetch('http://localhost:8080/api/v1/channels', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          server_id: activeServerId,
          name: name.trim(),
          type,
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
        general:
          error instanceof Error ? error.message : 'Failed to create channel',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const getChannelTypeIcon = (channelType: 'text' | 'voice' | 'bulletin') => {
    switch (channelType) {
      case 'text':
        return '#';
      case 'voice':
        return '🔊';
      case 'bulletin':
        return '📢';
      default:
        return '#';
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Channel">
      <form onSubmit={handleSubmit} className="create-channel-form">
        {/* General Error */}
        {errors.general && (
          <div className="form-error-banner">{errors.general}</div>
        )}

        {/* Success Message */}
        {successMessage && (
          <div className="form-success-banner">{successMessage}</div>
        )}

        {/* Channel Name */}
        <div className="form-group">
          <label htmlFor="channel-name" className="form-label">
            Channel Name <span className="required">*</span>
          </label>
          <input
            id="channel-name"
            type="text"
            className={`form-input ${errors.name ? 'error' : ''}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="general-chat"
            maxLength={NAME_MAX}
            disabled={isSubmitting}
            autoFocus
          />
          {errors.name && <span className="form-error">{errors.name}</span>}
          <span className="form-hint">
            {name.length}/{NAME_MAX} characters
          </span>
        </div>

        {/* Channel Type */}
        <div className="form-group">
          <label className="form-label">
            Channel Type <span className="required">*</span>
          </label>
          <div className="channel-type-selector">
            <button
              type="button"
              className={`channel-type-option ${
                type === 'text' ? 'selected' : ''
              }`}
              onClick={() => setType('text')}
              disabled={isSubmitting}
            >
              <span className="channel-type-icon">
                {getChannelTypeIcon('text')}
              </span>
              <div className="channel-type-info">
                <span className="channel-type-name">Text</span>
                <span className="channel-type-desc">
                  Send messages, images, and files
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`channel-type-option ${
                type === 'voice' ? 'selected' : ''
              }`}
              onClick={() => setType('voice')}
              disabled={isSubmitting}
            >
              <span className="channel-type-icon">
                {getChannelTypeIcon('voice')}
              </span>
              <div className="channel-type-info">
                <span className="channel-type-name">Voice</span>
                <span className="channel-type-desc">
                  Voice and video conversations
                </span>
              </div>
            </button>

            <button
              type="button"
              className={`channel-type-option ${
                type === 'bulletin' ? 'selected' : ''
              }`}
              onClick={() => setType('bulletin')}
              disabled={isSubmitting}
            >
              <span className="channel-type-icon">
                {getChannelTypeIcon('bulletin')}
              </span>
              <div className="channel-type-info">
                <span className="channel-type-name">Bulletin</span>
                <span className="channel-type-desc">
                  Important announcements only
                </span>
              </div>
            </button>
          </div>
          {errors.type && <span className="form-error">{errors.type}</span>}
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
