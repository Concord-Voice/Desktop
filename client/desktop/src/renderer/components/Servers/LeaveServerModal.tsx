import React, { useState } from 'react';
import Modal from '../ui/Modal';
import LoadingSpinner from '../Auth/LoadingSpinner';
import { useServerStore } from '../../stores/serverStore';
import { useUserStore } from '../../stores/userStore';
import { apiFetch } from '../../services/apiClient';
import { ServerWithRole } from '../../types/server';
import './DeleteServerModal.css';

interface LeaveServerModalProps {
  isOpen: boolean;
  server: ServerWithRole;
  onClose: () => void;
}

const LeaveServerModal: React.FC<LeaveServerModalProps> = ({
  isOpen,
  server,
  onClose,
}) => {
  const [error, setError] = useState<string | null>(null);
  const [isLeaving, setIsLeaving] = useState(false);
  const userId = useUserStore((s) => s.user?.id);

  const handleClose = () => {
    if (!isLeaving) {
      setError(null);
      onClose();
    }
  };

  const handleLeave = async () => {
    if (!userId) return;

    setIsLeaving(true);
    setError(null);

    try {
      const response = await apiFetch(
        `/api/v1/servers/${server.id}/members/${userId}`,
        { method: 'DELETE' }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to leave server');
      }

      // The WebSocket member_removed event will handle store cleanup,
      // but also call removeServer directly for immediate UI feedback
      useServerStore.getState().removeServer(server.id);
      handleClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to leave server. Please try again.'
      );
      setIsLeaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Leave Server"
      width="small"
    >
      <div className="delete-server-content">
        <div className="delete-server-warning">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="warning-icon">
            <path
              d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <p>
            Are you sure you want to leave <strong>{server.name}</strong>? You will lose
            access to all channels and messages in this server. You will need a new invite
            to rejoin.
          </p>
        </div>

        {error && (
          <div className="form-error-banner">
            <span>{error}</span>
          </div>
        )}

        <div className="delete-server-actions">
          <button
            type="button"
            className="delete-server-cancel-btn"
            onClick={handleClose}
            disabled={isLeaving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="delete-server-confirm-btn"
            onClick={handleLeave}
            disabled={isLeaving}
          >
            {isLeaving ? (
              <>
                Leaving...
                <LoadingSpinner size="small" inline />
              </>
            ) : (
              'Leave Server'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default LeaveServerModal;
