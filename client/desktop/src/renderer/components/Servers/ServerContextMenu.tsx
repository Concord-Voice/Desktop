import React, { useEffect, useRef } from 'react';
import { ServerWithRole } from '../../types/server';
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

  const canEdit = server.role === 'owner' || server.role === 'admin';
  const canDelete = server.role === 'owner';

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

        {/* No actions available for members */}
        {!canEdit && !canDelete && (
          <div className="context-menu-no-actions">
            No actions available
          </div>
        )}
      </div>
    </div>
  );
};

export default ServerContextMenu;
