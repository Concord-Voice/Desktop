import React, { useState } from 'react';
import Modal from '../ui/Modal';
import LoadingSpinner from '../Auth/LoadingSpinner';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { apiFetch } from '../../services/apiClient';
import { ChannelGroup } from '../../types/chat';
import '../Servers/DeleteServerModal.css';

interface DeleteCategoryModalProps {
  isOpen: boolean;
  group: ChannelGroup;
  onClose: () => void;
}

const DeleteCategoryModal: React.FC<DeleteCategoryModalProps> = ({ isOpen, group, onClose }) => {
  const [error, setError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const activeServerId = useServerStore((state) => state.activeServerId);
  const removeChannelGroup = useChannelStore((state) => state.removeChannelGroup);

  const handleClose = () => {
    if (!isDeleting) {
      setError(null);
      onClose();
    }
  };

  const handleDelete = async () => {
    if (!activeServerId) return;

    setIsDeleting(true);
    setError(null);

    try {
      const response = await apiFetch(
        `/api/v1/servers/${activeServerId}/channel-groups/${group.id}`,
        {
          method: 'DELETE',
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete category');
      }

      removeChannelGroup(group.id);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete category. Please try again.');
      setIsDeleting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Delete Category" width="small">
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
            <line
              x1="12"
              y1="9"
              x2="12"
              y2="13"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <line
              x1="12"
              y1="17"
              x2="12.01"
              y2="17"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <p>
            Are you sure you want to delete the <strong>{group.name}</strong> category? Channels in
            this category will become uncategorized. No channels or messages will be deleted.
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
            disabled={isDeleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="delete-server-confirm-btn"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                Deleting...
                <LoadingSpinner size="small" inline />
              </>
            ) : (
              'Delete Category'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default DeleteCategoryModal;
