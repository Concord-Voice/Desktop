import React, { useEffect, useRef, useState, useLayoutEffect } from 'react';
import type { PresenceStatus } from '../../stores/memberStore';
import { resolveUserAccentColors } from '../../utils/schemeColors';
import { useUserThemeScope } from '../../hooks/useUserThemeScope';
import './MemberProfileCard.css';

/** Flexible member shape that works for both ServerMembers and Friends */
export interface ProfileCardMember {
  user_id: string;
  username: string;
  display_name?: string;
  bio?: string;
  avatar_url?: string;
  header_image_url?: string;
  color_scheme?: string;
  role?: 'owner' | 'admin' | 'member';
  joined_at?: string;
}

interface MemberProfileCardProps {
  member: ProfileCardMember;
  status?: PresenceStatus;
  lastSeen?: number;
  position: { x: number; y: number };
  onClose: () => void;
  onViewFullProfile?: () => void;
}

const MemberProfileCard: React.FC<MemberProfileCardProps> = ({
  member,
  status,
  lastSeen,
  position,
  onClose,
  onViewFullProfile,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
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

  // Measure actual card size and clamp to viewport with padding
  const PADDING = 8;
  const [adjustedPos, setAdjustedPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const cardW = rect.width;
    const cardH = rect.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Preferred: position to the left of the click point, below the cursor
    let left = position.x - cardW - 10;
    let top = position.y + 10;

    // If it overflows left, flip to the right of the click
    if (left < PADDING) {
      left = position.x + 10;
    }
    // Clamp right edge
    if (left + cardW > vw - PADDING) {
      left = vw - cardW - PADDING;
    }
    // Clamp left edge
    if (left < PADDING) {
      left = PADDING;
    }
    // Clamp bottom edge
    if (top + cardH > vh - PADDING) {
      top = vh - cardH - PADDING;
    }
    // Clamp top edge
    if (top < PADDING) {
      top = PADDING;
    }

    setAdjustedPos({ top, left });
  }, [position]);

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

  const effectiveStatus = status ?? 'offline';

  const getStatusText = (): string => {
    if (effectiveStatus === 'online') return 'Online';
    if (effectiveStatus === 'dnd') return 'Do Not Disturb';
    if (effectiveStatus === 'invisible') return 'Offline'; // Invisible shows as Offline to others
    if (lastSeen) return `Last seen ${formatLastSeen(lastSeen)}`;
    return 'Offline';
  };

  const roleLabel = member.role
    ? member.role.charAt(0).toUpperCase() + member.role.slice(1)
    : undefined;
  const userColors = resolveUserAccentColors(member.color_scheme);
  const { scopeProps } = useUserThemeScope(member.color_scheme);

  return (
    <div
      ref={cardRef}
      className="member-profile-card"
      {...scopeProps}
      style={{
        ...scopeProps.style,
        position: 'fixed',
        top: adjustedPos?.top ?? -9999,
        left: adjustedPos?.left ?? -9999,
        zIndex: 400,
        visibility: adjustedPos ? 'visible' : 'hidden',
      }}
    >
      <div
        className={`member-profile-banner ${member.header_image_url ? 'has-image' : ''}`}
        style={
          !member.header_image_url && userColors
            ? { background: userColors.gradient, opacity: 0.6 }
            : undefined
        }
      >
        {member.header_image_url && (
          <img src={member.header_image_url} alt="" className="member-profile-banner-img" />
        )}
      </div>

      <div className="member-profile-header">
        <div className="member-profile-avatar">
          {member.avatar_url ? (
            <img
              src={member.avatar_url}
              alt={member.username}
              className="member-profile-avatar-img"
            />
          ) : (
            <span
              className="member-profile-avatar-initial"
              style={userColors ? { background: userColors.gradient, color: '#fff' } : undefined}
            >
              {member.username.charAt(0).toUpperCase()}
            </span>
          )}
          <span className={`member-profile-status ${effectiveStatus}`} />
        </div>
      </div>

      <div className="member-profile-body">
        <div className="member-profile-name">{member.display_name || member.username}</div>
        <div className="member-profile-username">@{member.username}</div>

        <div className="member-profile-separator" />

        <div className="member-profile-details">
          {member.role && roleLabel && (
            <div className="member-profile-detail-row">
              <span className="member-profile-detail-label">Role</span>
              <span className={`member-profile-role-badge role-${member.role}`}>{roleLabel}</span>
            </div>
          )}

          <div className="member-profile-detail-row">
            <span className="member-profile-detail-label">Status</span>
            <span className={`member-profile-detail-value status-${effectiveStatus}`}>
              {getStatusText()}
            </span>
          </div>

          {member.joined_at && (
            <div className="member-profile-detail-row">
              <span className="member-profile-detail-label">Joined</span>
              <span className="member-profile-detail-value">{formatDate(member.joined_at)}</span>
            </div>
          )}
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

        {onViewFullProfile && (
          <>
            <div className="member-profile-separator" />
            <button
              className="member-profile-view-full-btn"
              onClick={() => {
                onClose();
                onViewFullProfile();
              }}
            >
              View Full Profile
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default MemberProfileCard;
