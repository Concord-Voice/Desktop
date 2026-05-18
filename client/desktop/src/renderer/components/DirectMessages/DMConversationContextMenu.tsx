import React from 'react';
import ContextMenu from '../ui/ContextMenu';
import { useRotateKey } from '../../hooks/useRotateKey';
import type { DMConversation } from '../../stores/dmStore';

interface DMConversationContextMenuProps {
  conversation: DMConversation;
  currentUserId: string;
  position: { x: number; y: number };
  onClose: () => void;
}

const DMConversationContextMenu: React.FC<DMConversationContextMenuProps> = ({
  conversation,
  currentUserId,
  position,
  onClose,
}) => {
  const canRotateKey = !conversation.isGroup || conversation.createdBy === currentUserId;

  const { rotateStatus, rotateMessage, handleRotate } = useRotateKey(
    `/api/v1/dm/conversations/${conversation.id}/rotate-key`,
    () => setTimeout(() => onClose(), 800)
  );

  const getRotateLabel = (): string => {
    if (rotateStatus === 'success') return 'Key Rotated!';
    if (rotateStatus === 'error') return rotateMessage;
    return 'Rotate Encryption Key';
  };

  return (
    <ContextMenu position={position} onClose={onClose}>
      {canRotateKey ? (
        <ContextMenu.Item
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M11 1.5a3.5 3.5 0 00-3.5 3.5c0 .47.1.92.27 1.33L2 12.1V14h1.9l5.77-5.77c.41.17.86.27 1.33.27A3.5 3.5 0 0014.5 5 3.5 3.5 0 0011 1.5zm0 2a1.5 1.5 0 110 3 1.5 1.5 0 010-3z"
                fill="currentColor"
              />
              <path
                d="M1.5 8.5l2-2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          }
          label={getRotateLabel()}
          disabled={rotateStatus === 'success'}
          onClick={handleRotate}
        />
      ) : (
        <ContextMenu.Item label="No actions available" disabled onClick={() => {}} />
      )}
    </ContextMenu>
  );
};

export default DMConversationContextMenu;
