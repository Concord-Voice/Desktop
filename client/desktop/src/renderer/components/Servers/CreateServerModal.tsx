import React, { useState, useRef } from 'react';
import Modal from '../ui/Modal';
import LoadingSpinner from '../Auth/LoadingSpinner';
import { useServerStore } from '../../stores/serverStore';
import { apiFetch } from '../../services/apiClient';
import { ServerWithRole } from '../../types/server';
import './CreateServerModal.css';

interface CreateServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (server: ServerWithRole) => void;
}

interface FormErrors {
  name?: string;
  icon?: string;
  general?: string;
}

const MAX_ICON_SIZE = 256 * 1024; // 256KB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const NAME_MIN = 3;
const NAME_MAX = 100;

const CreateServerModal: React.FC<CreateServerModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [name, setName] = useState('');
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(null);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resetForm = () => {
    setName('');
    setIconPreview(null);
    setIconDataUrl(null);
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
      newErrors.name = 'Server name is required';
    } else if (trimmed.length < NAME_MIN) {
      newErrors.name = `Server name must be at least ${NAME_MIN} characters`;
    } else if (trimmed.length > NAME_MAX) {
      newErrors.name = `Server name must be at most ${NAME_MAX} characters`;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleIconClick = () => {
    fileInputRef.current?.click();
  };

  const handleIconKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleIconClick();
    }
  };

  const handleIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      setErrors((prev) => ({
        ...prev,
        icon: 'Only PNG, JPEG, GIF, and WebP images are allowed',
      }));
      return;
    }

    if (file.size > MAX_ICON_SIZE) {
      setErrors((prev) => ({
        ...prev,
        icon: 'Image must be smaller than 256KB',
      }));
      return;
    }

    setErrors((prev) => ({ ...prev, icon: undefined }));

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      setIconPreview(dataUrl);
      setIconDataUrl(dataUrl);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveIcon = () => {
    setIconPreview(null);
    setIconDataUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setSuccessMessage(null);

    if (!validateForm()) return;

    setIsSubmitting(true);

    try {
      const body: { name: string; icon_url?: string } = {
        name: name.trim(),
      };
      if (iconDataUrl) {
        body.icon_url = iconDataUrl;
      }

      const response = await apiFetch('/api/v1/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to create server');
      }

      setSuccessMessage('Server created successfully!');

      const serverWithRole: ServerWithRole = {
        ...data.server,
        role: data.role as ServerWithRole['role'],
      };
      useServerStore.getState().addServer(serverWithRole);

      setTimeout(() => {
        onSuccess(serverWithRole);
        resetForm();
        onClose();
      }, 800);
    } catch (error) {
      setErrors({
        general:
          error instanceof Error
            ? error.message
            : 'Failed to create server. Please try again.',
      });
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Create a Server"
      width="medium"
    >
      <form className="create-server-form" onSubmit={handleSubmit}>
        {/* Icon Upload */}
        <div className="server-icon-upload">
          <div
            className="icon-upload-area"
            onClick={handleIconClick}
            onKeyDown={handleIconKeyDown}
            role="button"
            tabIndex={0}
            aria-label="Upload server icon"
          >
            {iconPreview ? (
              <img src={iconPreview} alt="Server icon preview" className="icon-preview" />
            ) : (
              <div className="icon-placeholder">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
                <span className="icon-placeholder-text">Upload</span>
              </div>
            )}
          </div>
          {iconPreview && (
            <button
              type="button"
              className="icon-remove-btn"
              onClick={handleRemoveIcon}
            >
              Remove
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={handleIconChange}
            hidden
          />
          {errors.icon && <span className="form-error">{errors.icon}</span>}
        </div>

        {/* Server Name */}
        <div className="form-group">
          <label className="form-label">Server Name</label>
          <input
            type="text"
            className={`form-input ${errors.name ? 'error' : ''}`}
            placeholder="My Awesome Server"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
            }}
            disabled={isSubmitting}
            autoFocus
            maxLength={NAME_MAX}
          />
          {errors.name && <span className="form-error">{errors.name}</span>}
          <span className="form-hint">
            {name.trim().length}/{NAME_MAX} characters
          </span>
        </div>

        {/* General Error */}
        {errors.general && (
          <div className="form-error-banner">
            <span>{errors.general}</span>
          </div>
        )}

        {/* Success Message */}
        {successMessage && (
          <div className="form-success-banner">
            <span>{successMessage}</span>
          </div>
        )}

        {/* Buttons */}
        <div className="create-server-actions">
          <button
            type="button"
            className="create-server-cancel-btn"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="create-server-submit-btn"
            disabled={isSubmitting || !!successMessage}
          >
            {isSubmitting ? (
              <>
                Creating...
                <LoadingSpinner size="small" inline />
              </>
            ) : (
              'Create Server'
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default CreateServerModal;
