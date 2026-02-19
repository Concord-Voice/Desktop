import React, { useState, useRef, useEffect } from 'react';
import Modal from '../ui/Modal';
import LoadingSpinner from '../Auth/LoadingSpinner';
import { useServerStore } from '../../stores/serverStore';
import { useInviteStore } from '../../stores/inviteStore';
import { apiFetch } from '../../services/apiClient';
import { ServerWithRole } from '../../types/server';
import './ServerSettingsModal.css';

interface ServerSettingsModalProps {
  isOpen: boolean;
  server: ServerWithRole;
  onClose: () => void;
}

interface FormErrors {
  name?: string;
  icon?: string;
  general?: string;
}

const MAX_ICON_SIZE = 256 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const NAME_MIN = 3;
const NAME_MAX = 100;

const ServerSettingsModal: React.FC<ServerSettingsModalProps> = ({
  isOpen,
  server,
  onClose,
}) => {
  const [name, setName] = useState(server.name);
  const [iconPreview, setIconPreview] = useState<string | null>(server.icon_url || null);
  const [iconDataUrl, setIconDataUrl] = useState<string | null>(server.icon_url || null);
  const [iconRemoved, setIconRemoved] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canManageInvites = server.role === 'owner' || server.role === 'admin';
  const invites = useInviteStore((state) => state.invites[server.id] || []);
  const fetchInvites = useInviteStore((state) => state.fetchInvites);
  const createInvite = useInviteStore((state) => state.createInvite);

  // Find first active (non-revoked, non-expired) invite
  const activeInvite = invites.find((inv) => {
    if (inv.is_revoked) return false;
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return false;
    if (inv.max_uses !== null && inv.use_count >= inv.max_uses) return false;
    return true;
  });

  // Reset form when server changes
  useEffect(() => {
    setName(server.name);
    setIconPreview(server.icon_url || null);
    setIconDataUrl(server.icon_url || null);
    setIconRemoved(false);
    setErrors({});
    setIsSubmitting(false);
    setSuccessMessage(null);
    setInviteCopied(false);
    setIsCreatingInvite(false);
  }, [server]);

  // Fetch invites when modal opens for owner/admin
  useEffect(() => {
    if (isOpen && canManageInvites) {
      fetchInvites(server.id);
    }
  }, [isOpen, canManageInvites, server.id, fetchInvites]);

  const handleClose = () => {
    if (!isSubmitting) {
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
      setIconRemoved(false);
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveIcon = () => {
    setIconPreview(null);
    setIconDataUrl(null);
    setIconRemoved(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setSuccessMessage(null);

    if (!validateForm()) return;

    setIsSubmitting(true);

    try {
      const body: { name: string; icon_url?: string | null } = {
        name: name.trim(),
      };

      if (iconRemoved) {
        body.icon_url = null;
      } else if (iconDataUrl && iconDataUrl !== server.icon_url) {
        body.icon_url = iconDataUrl;
      }

      const response = await apiFetch(`/api/v1/servers/${server.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to update server');
      }

      useServerStore.getState().updateServer(server.id, {
        name: data.server.name,
        icon_url: data.server.icon_url,
        updated_at: data.server.updated_at,
      });

      // Server update is broadcast to all clients by the backend PATCH handler,
      // so no separate WS message is needed here.

      setSuccessMessage('Server updated successfully!');

      setTimeout(() => {
        onClose();
      }, 800);
    } catch (error) {
      setErrors({
        general:
          error instanceof Error
            ? error.message
            : 'Failed to update server. Please try again.',
      });
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Server Settings"
      width="medium"
    >
      <form className="server-settings-form" onSubmit={handleSubmit}>
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
                  <path
                    d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.5" />
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

        {/* Invite Code Section */}
        {canManageInvites && (
          <div className="invite-section">
            <label className="form-label">Invite Code</label>
            {activeInvite ? (
              <div className="invite-code-row">
                <code className="invite-code-display">{activeInvite.code}</code>
                <button
                  type="button"
                  className="invite-copy-btn"
                  onClick={() => {
                    navigator.clipboard.writeText(activeInvite.code);
                    setInviteCopied(true);
                    setTimeout(() => setInviteCopied(false), 2000);
                  }}
                >
                  {inviteCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="invite-generate-btn"
                disabled={isCreatingInvite}
                onClick={async () => {
                  setIsCreatingInvite(true);
                  await createInvite(server.id);
                  setIsCreatingInvite(false);
                }}
              >
                {isCreatingInvite ? (
                  <>
                    Generating...
                    <LoadingSpinner size="small" inline />
                  </>
                ) : (
                  'Generate Invite Code'
                )}
              </button>
            )}
            <span className="form-hint">
              Invites default to 1 use, expire in 24 hours.
            </span>
          </div>
        )}

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
        <div className="server-settings-actions">
          <button
            type="button"
            className="server-settings-cancel-btn"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="server-settings-submit-btn"
            disabled={isSubmitting || !!successMessage}
          >
            {isSubmitting ? (
              <>
                Saving...
                <LoadingSpinner size="small" inline />
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

export default ServerSettingsModal;
