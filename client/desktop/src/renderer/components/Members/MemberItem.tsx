import React from 'react';
import type { ServerMember, PresenceStatus } from '../../stores/memberStore';
import { resolveUserAccentColors } from '../../utils/schemeColors';

interface MemberItemProps {
  member: ServerMember;
  status: PresenceStatus;
  onClick: (e: React.MouseEvent, member: ServerMember) => void;
  onContextMenu: (e: React.MouseEvent, member: ServerMember) => void;
}

const MemberItem: React.FC<MemberItemProps> = ({ member, status, onClick, onContextMenu }) => {
  const memberColors = resolveUserAccentColors(member.color_scheme);
  const topDisplayRole = member.roles?.length
    ? ([...member.roles]
        .filter((r) => r.display_separately)
        .sort((a, b) => b.position - a.position)[0] ?? null)
    : null;
  const roleColor = topDisplayRole?.role_color ?? null;
  return (
    <button
      type="button"
      className={`member-item ${status}`}
      onClick={(e) => onClick(e, member)}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => onContextMenu(e, member)}
      title={member.display_name || member.username}
    >
      <div className="member-avatar">
        {member.avatar_url ? (
          <img src={member.avatar_url} alt={member.username} className="member-avatar-img" />
        ) : (
          <span
            className="member-avatar-initial"
            style={memberColors ? { background: memberColors.gradient, color: '#fff' } : undefined}
          >
            {member.username.charAt(0).toUpperCase()}
          </span>
        )}
        <span className={`member-status-dot ${status}`} />
      </div>
      <span className="member-username" style={roleColor ? { color: roleColor } : undefined}>
        {member.display_name || member.username}
      </span>
    </button>
  );
};

export default React.memo(MemberItem);
