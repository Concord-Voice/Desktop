import React, { useState, useEffect, useRef } from 'react';
import { ServerWithRole } from '../../types/server';
import { useInviteStore } from '../../stores/inviteStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { apiFetch } from '../../services/apiClient';
import './ServerContextMenu.css';

interface ServerContextMenuProps {
  server: ServerWithRole;
  position: { x: number; y: number };
  onClose: () => void;
  onEditServer: (server: ServerWithRole) => void;
  onDeleteServer: (server: ServerWithRole) => void;
}

const ServerContextMenu: React.FC<ServerContextMenuProps> = ({
  server,
  position,
  onClose,
  onEditServer,
  onDeleteServer,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position if menu would overflow viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      if (rect.bottom > viewportHeight) {
        menuRef.current.style.top = `${position.y - rect.height}px`;
      }
      if (rect.right > viewportWidth) {
        menuRef.current.style.left = `${position.x - rect.width}px`;
      }
    }
  }, [position]);

  const [copiedInvite, setCopiedInvite] = useState(false);
  const createInvite = useInviteStore((state) => state.createInvite);
  const invites = useInviteStore((state) => state.invites[server.id] || []);
  const fetchInvites = useInviteStore((state) => state.fetchInvites);

  const canEdit = server.role === 'owner' || server.role === 'admin';
  const canDelete = server.role === 'owner';

  // Fetch invites on mount if can manage
  useEffect(() => {
    if (canEdit) {
      fetchInvites(server.id);
    }
  }, [canEdit, server.id, fetchInvites]);

  const activeInvite = invites.find((inv) => {
    if (inv.is_revoked) return false;
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return false;
    if (inv.max_uses !== null && inv.use_count >= inv.max_uses) return false;
    return true;
  });

  const handleCopyInvite = async () => {
    if (activeInvite) {
      await navigator.clipboard.writeText(activeInvite.code);
      setCopiedInvite(true);
      setTimeout(() => onClose(), 800);
    } else {
      // Generate a new one on the fly
      const invite = await createInvite(server.id);
      if (invite) {
        await navigator.clipboard.writeText(invite.code);
        setCopiedInvite(true);
        setTimeout(() => onClose(), 800);
      }
    }
  };

  return (
    <div className="context-menu-overlay">
      <div
        ref={menuRef}
        className="context-menu"
        style={{ top: position.y, left: position.x }}
      >
        {/* Server info header */}
        <div className="context-menu-header">
          <span className="context-menu-server-name">{server.name}</span>
          <span className={`context-menu-role role-${server.role}`}>
            {server.role}
          </span>
        </div>

        <div className="context-menu-separator" />

        {/* Mark All as Read */}
        <button
          className="context-menu-item"
          onClick={() => {
            // Clear all channel unreads + server dot locally
            useUnreadStore.getState().clearAll();
            useUnreadStore.getState().clearServerUnread(server.id);
            // Mark all channels as read on the server
            apiFetch(`/api/v1/servers/${server.id}/read`, { method: 'POST' }).catch(() => {});
            onClose();
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 8.5l3.5 3.5L14 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Mark All as Read
        </button>

        {/* Edit Server */}
        {canEdit && (
          <button
            className="context-menu-item"
            onClick={() => onEditServer(server)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Edit Server
          </button>
        )}

        {/* Copy Invite Code */}
        {canEdit && (
          <button
            className="context-menu-item"
            onClick={handleCopyInvite}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {copiedInvite ? 'Copied!' : 'Copy Invite Code'}
          </button>
        )}

        {/* Delete Server */}
        {canDelete && (
          <button
            className="context-menu-item context-menu-item-danger"
            onClick={() => onDeleteServer(server)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M12.67 4v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Delete Server
          </button>
        )}

        {/* "Mark All as Read" is always available, so this is no longer needed */}
      </div>
    </div>
  );
};

export default ServerContextMenu;
