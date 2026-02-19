import React, { useState } from 'react';
import Modal from '../ui/Modal';
import LoadingSpinner from '../Auth/LoadingSpinner';
import { useServerStore } from '../../stores/serverStore';
import { apiFetch } from '../../services/apiClient';
import { ServerWithRole } from '../../types/server';
import './DeleteServerModal.css';

interface DeleteServerModalProps {
  isOpen: boolean;
  server: ServerWithRole;
  onClose: () => void;
}

const DeleteServerModal: React.FC<DeleteServerModalProps> = ({
  isOpen,
  server,
  onClose,
}) => {
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const handleClose = () => {
    if (!isDeleting) {
      setConfirmName('');
      setError(null);
      onClose();
    }
  };

  const isConfirmed = confirmName === server.name;

  const handleDelete = async () => {
    if (!isConfirmed) return;

    setIsDeleting(true);
    setError(null);

    try {
      const response = await apiFetch(`/api/v1/servers/${server.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete server');
      }

      useServerStore.getState().removeServer(server.id);
      handleClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete server. Please try again.'
      );
      setIsDeleting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Delete Server"
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
            Are you sure you want to delete <strong>{server.name}</strong>? This action
            cannot be undone. All channels and messages in this server will be permanently
            deleted.
          </p>
        </div>

        <div className="delete-server-confirm">
          <label className="form-label">
            Type <strong>{server.name}</strong> to confirm
          </label>
          <input
            type="text"
            className="form-input"
            placeholder={server.name}
            value={confirmName}
            onChange={(e) => {
              setConfirmName(e.target.value);
              if (error) setError(null);
            }}
            disabled={isDeleting}
            autoFocus
          />
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
            disabled={isDeleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="delete-server-confirm-btn"
            onClick={handleDelete}
            disabled={!isConfirmed || isDeleting}
          >
            {isDeleting ? (
              <>
                Deleting...
                <LoadingSpinner size="small" inline />
              </>
            ) : (
              'Delete Server'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default DeleteServerModal;
