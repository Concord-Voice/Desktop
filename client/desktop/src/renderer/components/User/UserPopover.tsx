import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserProfile, useUserStore } from '../../stores/userStore';
import './UserPopover.css';

interface UserPopoverProps {
  user: UserProfile;
  onClose: () => void;
}

const UserPopover: React.FC<UserPopoverProps> = ({ user, onClose }) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const logout = useUserStore((state) => state.logout);

  // Close on outside click or Escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    // Delay adding listener to avoid immediate close from the click that opened it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    document.addEventListener('keydown', handleEscape);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleLogout = async () => {
    onClose();
    await logout();
    navigate('/');
  };

  return (
    <div ref={popoverRef} className="user-popover">
      {/* User info header */}
      <div className="user-popover-header">
        <div className="user-popover-avatar">
          <span className="user-popover-avatar-initial">
            {user.username.charAt(0).toUpperCase()}
          </span>
        </div>
        <div className="user-popover-info">
          <span className="user-popover-username">{user.username}</span>
          <span className="user-popover-status">Online</span>
        </div>
      </div>

      {/* Email */}
      {user.email && (
        <div className="user-popover-email">
          {user.email}
        </div>
      )}

      <div className="user-popover-separator" />

      {/* Menu items */}
      <button className="user-popover-item" onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M2 14c0-2.76 2.69-5 6-5s6 2.24 6 5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
        My Profile
      </button>

      <button className="user-popover-item" onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M6.86 2.57a1.14 1.14 0 012.28 0 4.57 4.57 0 012.64 1.53 1.14 1.14 0 011.97 1.14 4.57 4.57 0 010 3.05 1.14 1.14 0 01-1.97 1.14 4.57 4.57 0 01-2.64 1.53 1.14 1.14 0 01-2.28 0 4.57 4.57 0 01-2.64-1.53 1.14 1.14 0 01-1.97-1.14 4.57 4.57 0 010-3.05 1.14 1.14 0 011.97-1.14A4.57 4.57 0 016.86 2.57z"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        Settings
      </button>

      <div className="user-popover-separator" />

      {/* Logout */}
      <button className="user-popover-item user-popover-item-danger" onClick={handleLogout}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M6 14H3.33A1.33 1.33 0 012 12.67V3.33A1.33 1.33 0 013.33 2H6M10.67 11.33L14 8l-3.33-3.33M14 8H6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Log Out
      </button>
    </div>
  );
};

export default UserPopover;
