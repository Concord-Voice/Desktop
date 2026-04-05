import React, { useState } from 'react';
import { MicOff, HeadphoneOff, Lock } from 'lucide-react';
import type { ServerMember } from '../../stores/memberStore';
import type { Role } from '../../types/server';
import { resolveUserAccentColors } from '../../utils/schemeColors';

interface MemberListPanelProps {
  members: ServerMember[];
  assignableRoles: Role[];
  onToggleRole: (userId: string, roleId: string, hasRole: boolean) => void;
}

function AddRoleDropdown({
  memberId,
  unassignedRoles,
  onToggleRole,
}: Readonly<{
  memberId: string;
  unassignedRoles: Role[];
  onToggleRole: (userId: string, roleId: string, hasRole: boolean) => void;
}>) {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownId = `role-dropdown-${memberId}`;

  return (
    <div className="member-role-add-wrapper">
      <button
        type="button"
        className="member-role-add-btn"
        onClick={() => setShowDropdown(!showDropdown)}
        aria-haspopup="true"
        aria-expanded={showDropdown}
        aria-controls={showDropdown ? dropdownId : undefined}
      >
        + Add Role
      </button>
      {showDropdown && (
        <div className="member-role-dropdown" id={dropdownId} role="menu">
          {unassignedRoles.map((role) => (
            <button
              key={role.id}
              type="button"
              className="member-role-dropdown__item"
              role="menuitem"
              onClick={() => {
                onToggleRole(memberId, role.id, false);
                setShowDropdown(false);
              }}
            >
              <span
                className="role-color-dot"
                style={{ backgroundColor: role.color || '#99aab5' }}
              />
              {role.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const MemberListPanel: React.FC<MemberListPanelProps> = ({
  members,
  assignableRoles,
  onToggleRole,
}) => {
  return (
    <div className="members-list">
      <div className="member-list-header">
        <span>User</span>
        <span>Roles</span>
      </div>
      {members.map((member) => {
        const assignedRoles = assignableRoles.filter((role) =>
          member.roles.some((r) => r.role_id === role.id)
        );
        const unassignedRoles = assignableRoles.filter(
          (role) => !member.roles.some((r) => r.role_id === role.id)
        );
        const initial = (member.display_name || member.username).charAt(0).toUpperCase();

        return (
          <div key={member.user_id} className="member-row">
            <div className="member-cell member-cell--user">
              {member.avatar_url ? (
                <img src={member.avatar_url} alt="" className="member-avatar" />
              ) : (
                <div
                  className="member-avatar member-avatar--initial"
                  style={(() => {
                    const colors = resolveUserAccentColors(member.color_scheme);
                    return colors ? { background: colors.gradient } : undefined;
                  })()}
                >
                  {initial}
                </div>
              )}
              <div>
                <span className="member-name">{member.display_name || member.username}</span>
                {member.server_deafened && (
                  <span className="member-enforcement-badge" title="Server Deafened">
                    <HeadphoneOff size={14} />
                    <Lock size={8} className="enforcement-lock-badge" />
                  </span>
                )}
                {member.server_muted && !member.server_deafened && (
                  <span className="member-enforcement-badge" title="Server Muted">
                    <MicOff size={14} />
                    <Lock size={8} className="enforcement-lock-badge" />
                  </span>
                )}
                {member.display_name && <span className="member-username">@{member.username}</span>}
              </div>
            </div>
            <div className="member-cell member-cell--roles">
              {assignedRoles.map((role) => (
                <span
                  key={role.id}
                  className="role-badge role-badge--removable"
                  style={{ backgroundColor: role.color || '#99aab5' }}
                >
                  {role.name}
                  <button
                    type="button"
                    className="role-badge__remove"
                    onClick={() => onToggleRole(member.user_id, role.id, true)}
                    aria-label={`Remove ${role.name} role`}
                  >
                    ×
                  </button>
                </span>
              ))}
              {unassignedRoles.length > 0 && (
                <AddRoleDropdown
                  memberId={member.user_id}
                  unassignedRoles={unassignedRoles}
                  onToggleRole={onToggleRole}
                />
              )}
              {assignableRoles.length === 0 && (
                <span
                  style={{
                    color: 'var(--text-muted)',
                    fontSize: 'calc(12px * var(--font-scale, 1))',
                  }}
                >
                  No roles available to assign.
                </span>
              )}
            </div>
          </div>
        );
      })}
      {members.length === 0 && (
        <div style={{ color: 'var(--text-muted)', padding: '40px', textAlign: 'center' }}>
          No members found.
        </div>
      )}
    </div>
  );
};

export default MemberListPanel;
