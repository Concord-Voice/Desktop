import React, { useState } from 'react';
import type { ServerMember } from '../../stores/memberStore';
import type { Role } from '../../types/server';

interface MemberListPanelProps {
  members: ServerMember[];
  serverRoles: Role[];
  assignableRoles: Role[];
  onToggleRole: (userId: string, roleId: string, hasRole: boolean) => void;
}

function MemberRoleAssignment({
  member,
  assignableRoles,
  onToggleRole,
}: Readonly<{
  member: { user_id: string; roles: { role_id: string }[] };
  assignableRoles: Role[];
  onToggleRole: (userId: string, roleId: string, hasRole: boolean) => void;
}>) {
  return (
    <fieldset className="member-role-assignment">
      {assignableRoles.map((role) => {
        const hasRole = member.roles.some((r) => r.role_id === role.id);
        return (
          <label key={role.id} className="role-checkbox-row">
            <input
              type="checkbox"
              checked={hasRole}
              onChange={() => onToggleRole(member.user_id, role.id, hasRole)}
            />
            <span className="role-color-dot" style={{ backgroundColor: role.color || '#99aab5' }} />
            {role.name}
          </label>
        );
      })}
      {assignableRoles.length === 0 && (
        <span
          style={{
            color: 'var(--text-muted)',
            fontSize: 'calc(12px * var(--font-scale, 1))',
          }}
        >
          No roles available to assign. Create roles in the Roles tab first.
        </span>
      )}
    </fieldset>
  );
}

const MemberListPanel: React.FC<MemberListPanelProps> = ({
  members,
  serverRoles,
  assignableRoles,
  onToggleRole,
}) => {
  const [expandedMemberId, setExpandedMemberId] = useState<string | null>(null);

  const defaultRoleIds = new Set(serverRoles.filter((sr) => sr.is_default).map((sr) => sr.id));

  return (
    <div className="members-list">
      {members.map((member) => {
        const isExpanded = expandedMemberId === member.user_id;
        const nonDefaultRoles = member.roles.filter((r) => !defaultRoleIds.has(r.role_id));
        const assignmentId = `member-role-assignment-${member.user_id}`;
        return (
          <div key={member.user_id} className={`member-row ${isExpanded ? 'expanded' : ''}`}>
            <button
              type="button"
              className="member-row-toggle"
              aria-expanded={isExpanded}
              aria-controls={assignmentId}
              onClick={() => setExpandedMemberId(isExpanded ? null : member.user_id)}
            >
              <div className="member-info">
                {member.avatar_url ? (
                  <img src={member.avatar_url} alt="" className="member-avatar" />
                ) : (
                  <div className="member-avatar" />
                )}
                <div>
                  <span className="member-name">{member.display_name || member.username}</span>
                  {member.display_name && (
                    <span className="member-username">@{member.username}</span>
                  )}
                </div>
                <div className="member-roles">
                  {nonDefaultRoles.map((r) => (
                    <span
                      key={r.role_id}
                      className="role-badge"
                      style={{ backgroundColor: r.role_color || '#99aab5' }}
                    >
                      {r.role_name}
                    </span>
                  ))}
                </div>
              </div>
            </button>
            {isExpanded && (
              <div id={assignmentId}>
                <MemberRoleAssignment
                  member={member}
                  assignableRoles={assignableRoles}
                  onToggleRole={onToggleRole}
                />
              </div>
            )}
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
