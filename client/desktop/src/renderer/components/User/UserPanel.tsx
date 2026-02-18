import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useUserStore } from '../../stores/userStore';
import UserPopover from './UserPopover';
import './UserPanel.css';

const UserPanel: React.FC = () => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useUserStore((state) => state.user);
  const isLoading = useUserStore((state) => state.isLoading);
  const fetchUser = useUserStore((state) => state.fetchUser);

  // Fetch user data if not already loaded (e.g., on page refresh)
  useEffect(() => {
    if (accessToken && !user) {
      fetchUser();
    }
  }, [accessToken, user, fetchUser]);

  const handleTogglePopover = () => {
    setIsPopoverOpen((prev) => !prev);
  };

  return (
    <div className="user-panel">
      <div className="user-panel-separator" />

      {/* Loading skeleton */}
      {isLoading && !user && (
        <div className="user-avatar-skeleton" />
      )}

      {/* Loaded state */}
      {user && (
        <div className="user-avatar-wrapper">
          <button
            className={`user-avatar-btn ${isPopoverOpen ? 'active' : ''}`}
            onClick={handleTogglePopover}
            title={user.username}
            aria-label={`User menu for ${user.username}`}
          >
            {user.avatar_url ? (
              <img
                src={user.avatar_url}
                alt={user.username}
                className="user-avatar-img"
              />
            ) : (
              <span className="user-avatar-initial">
                {user.username.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="user-status-dot" />
          </button>

          {isPopoverOpen && (
            <UserPopover
              user={user}
              onClose={() => setIsPopoverOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default UserPanel;
