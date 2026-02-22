import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';
import { useUserStore } from '../../stores/userStore';
import { useMemberStore, PresenceStatus } from '../../stores/memberStore';
import UserPopover from './UserPopover';
import './UserPanel.css';

const statusClassMap: Record<PresenceStatus, string> = {
  online: 'online',
  dnd: 'dnd',
  invisible: 'invisible',
  offline: 'offline',
};

const statusLabelMap: Record<PresenceStatus, string> = {
  online: 'Online',
  dnd: 'Do Not Disturb',
  invisible: 'Invisible',
  offline: 'Offline',
};

interface UserPanelProps {
  /** Compact mode: smaller avatar, no separator, popover opens upward. Used in message input area. */
  compact?: boolean;
}

const UserPanel: React.FC<UserPanelProps> = ({ compact = false }) => {
  const navigate = useNavigate();
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useUserStore((state) => state.user);
  const isLoading = useUserStore((state) => state.isLoading);
  const fetchUser = useUserStore((state) => state.fetchUser);
  const selfStatus = useMemberStore((state) => state.selfStatus);

  // Fetch user data if not already loaded (e.g., on page refresh)
  useEffect(() => {
    if (accessToken && !user) {
      fetchUser();
    }
  }, [accessToken, user, fetchUser]);

  const handleTogglePopover = () => {
    setIsPopoverOpen((prev) => !prev);
  };

  const panelClass = compact ? 'user-panel user-panel-compact' : 'user-panel';
  const avatarSize = compact ? 'user-avatar-btn compact' : 'user-avatar-btn';

  return (
    <div className={panelClass}>
      {!compact && <div className="user-panel-separator" />}

      {/* Loading skeleton */}
      {isLoading && !user && (
        <div className={compact ? 'user-avatar-skeleton compact' : 'user-avatar-skeleton'} />
      )}

      {/* Loaded state */}
      {user && (
        <div className="user-avatar-wrapper">
          <button
            className={`${avatarSize} ${isPopoverOpen ? 'active' : ''}`}
            onClick={handleTogglePopover}
            title={user.username}
            aria-label={`User menu for ${user.username}`}
          >
            {user.avatar_url ? (
              <img src={user.avatar_url} alt={user.username} className="user-avatar-img" />
            ) : (
              <span className="user-avatar-initial">{user.username.charAt(0).toUpperCase()}</span>
            )}
            <div className={`user-status-dot ${statusClassMap[selfStatus]}`} />
          </button>

          {/* Full mode: show username, status, and settings */}
          {!compact && (
            <div className="user-panel-info">
              <span className="user-panel-username">{user.username}</span>
              <span className={`user-panel-status ${statusClassMap[selfStatus]}`}>
                {statusLabelMap[selfStatus]}
              </span>
            </div>
          )}

          {!compact && (
            <button
              className="user-panel-settings-btn"
              onClick={() => navigate('/app/settings')}
              title="Settings"
              aria-label="Settings"
            >
              <Settings size={16} />
            </button>
          )}

          {isPopoverOpen && <UserPopover user={user} onClose={() => setIsPopoverOpen(false)} />}
        </div>
      )}
    </div>
  );
};

export default UserPanel;
