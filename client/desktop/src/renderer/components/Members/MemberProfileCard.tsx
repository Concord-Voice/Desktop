import React, { useEffect, useRef } from 'react';
import { ServerMember, PresenceStatus } from '../../stores/memberStore';
import './MemberProfileCard.css';

interface MemberProfileCardProps {
  member: ServerMember;
  status: PresenceStatus;
  lastSeen?: number;
  position: { x: number; y: number };
  onClose: () => void;
}

const MemberProfileCard: React.FC<MemberProfileCardProps> = ({
  member,
  status,
  lastSeen,
  position,
  onClose,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape (same pattern as UserPopover)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

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

  // Clamp position to viewport
  const top = Math.min(position.y, window.innerHeight - 320);
  const left = Math.min(position.x - 290, window.innerWidth - 300);

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatLastSeen = (timestamp: number): string => {
    const now = Date.now();
    const diffMs = now - timestamp * 1000;
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) return 'Just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  const getStatusText = (): string => {
    if (status === 'online') return 'Online';
    if (status === 'dnd') return 'Do Not Disturb';
    if (status === 'invisible') return 'Offline'; // Invisible shows as Offline to others
    if (lastSeen) return `Last seen ${formatLastSeen(lastSeen)}`;
    return 'Offline';
  };

  const roleLabel = member.role.charAt(0).toUpperCase() + member.role.slice(1);

  return (
    <div
      ref={cardRef}
      className="member-profile-card"
      style={{ position: 'fixed', top, left, zIndex: 400 }}
    >
      <div className="member-profile-banner" />

      <div className="member-profile-header">
        <div className="member-profile-avatar">
          {member.avatar_url ? (
            <img
              src={member.avatar_url}
              alt={member.username}
              className="member-profile-avatar-img"
            />
          ) : (
            <span className="member-profile-avatar-initial">
              {member.username.charAt(0).toUpperCase()}
            </span>
          )}
          <span
            className={`member-profile-status ${status}`}
          />
        </div>
      </div>

      <div className="member-profile-body">
        <div className="member-profile-name">
          {member.display_name || member.username}
        </div>
        <div className="member-profile-username">@{member.username}</div>

        <div className="member-profile-separator" />

        <div className="member-profile-details">
          <div className="member-profile-detail-row">
            <span className="member-profile-detail-label">Role</span>
            <span className={`member-profile-role-badge role-${member.role}`}>
              {roleLabel}
            </span>
          </div>

          <div className="member-profile-detail-row">
            <span className="member-profile-detail-label">Status</span>
            <span
              className={`member-profile-detail-value status-${status}`}
            >
              {getStatusText()}
            </span>
          </div>

          <div className="member-profile-detail-row">
            <span className="member-profile-detail-label">Joined</span>
            <span className="member-profile-detail-value">
              {formatDate(member.joined_at)}
            </span>
          </div>
        </div>

        {member.bio && (
          <>
            <div className="member-profile-separator" />
            <div className="member-profile-bio">
              <span className="member-profile-detail-label">About</span>
              <p>{member.bio}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default MemberProfileCard;
