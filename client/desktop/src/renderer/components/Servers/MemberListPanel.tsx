import React, { useState, useCallback } from 'react';
import { MicOff, HeadphoneOff, Lock } from 'lucide-react';
import { useMemberStore, type ServerMember } from '../../stores/memberStore';
import type { Role } from '../../types/server';
import { resolveUserAccentColors } from '../../utils/schemeColors';
import MemberContextMenu from '../Members/MemberContextMenu';
import UserProfileModal from '../Members/UserProfileModal';
import ConfirmActionModal from '../ui/ConfirmActionModal';
import { apiFetch, safeJson } from '../../services/apiClient';

interface MemberListPanelProps {
  members: ServerMember[];
  assignableRoles: Role[];
  onToggleRole: (userId: string, roleId: string, hasRole: boolean) => void;
  serverId: string;
  ownerUserId: string;
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
  serverId,
  ownerUserId,
}) => {
  const [contextMenu, setContextMenu] = useState<{
    member: ServerMember;
    position: { x: number; y: number };
  } | null>(null);
  const [fullProfileUserId, setFullProfileUserId] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<ServerMember | null>(null);
  const [kickTarget, setKickTarget] = useState<ServerMember | null>(null);

  const fullProfileMemberData = fullProfileUserId
    ? (members.find((m) => m.user_id === fullProfileUserId) ?? null)
    : null;

  const handleContextMenu = useCallback((e: React.MouseEvent, member: ServerMember) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ member, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, member: ServerMember) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        setContextMenu({ member, position: { x: rect.left, y: rect.bottom } });
      }
    },
    []
  );

  return (
    <div className="members-list">
      <div className="member-list-header">
        <span>User</span>
        <span>Roles</span>
      </div>
      <ul className="member-list">
        {members.map((member) => {
          const assignedRoles = assignableRoles.filter((role) =>
            member.roles.some((r) => r.role_id === role.id)
          );
          const unassignedRoles = assignableRoles.filter(
            (role) => !member.roles.some((r) => r.role_id === role.id)
          );
          const initial = (member.display_name || member.username).charAt(0).toUpperCase();

          return (
            <li
              key={member.user_id}
              className="member-row"
              onContextMenu={(e) => handleContextMenu(e, member)}
            >
              <div className="member-cell member-cell--user">
                <button
                  type="button"
                  className="member-row-kbd-trigger"
                  aria-label={`Open context menu for ${member.display_name || member.username}`}
                  onKeyDown={(e) => handleKeyDown(e, member)}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setContextMenu({ member, position: { x: rect.left, y: rect.bottom } });
                  }}
                />
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
                  {member.display_name && (
                    <span className="member-username">@{member.username}</span>
                  )}
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
            </li>
          );
        })}
        {members.length === 0 && (
          <li style={{ color: 'var(--text-muted)', padding: '40px', textAlign: 'center' }}>
            No members found.
          </li>
        )}
      </ul>

      {contextMenu && (
        <MemberContextMenu
          member={contextMenu.member}
          position={contextMenu.position}
          serverId={serverId}
          ownerUserId={ownerUserId}
          onClose={() => setContextMenu(null)}
          onViewProfile={() => {
            setFullProfileUserId(contextMenu.member.user_id);
          }}
          onBan={(m) => {
            setContextMenu(null);
            setBanTarget(m);
          }}
          onKick={(m) => {
            setContextMenu(null);
            setKickTarget(m);
          }}
        />
      )}

      {fullProfileMemberData && (
        <UserProfileModal
          isOpen={!!fullProfileMemberData}
          onClose={() => setFullProfileUserId(null)}
          member={fullProfileMemberData}
          presenceStatus="offline"
        />
      )}

      <ConfirmActionModal
        isOpen={!!banTarget}
        onClose={() => setBanTarget(null)}
        title={`Ban ${banTarget?.display_name || banTarget?.username || 'User'}`}
        message="This will permanently remove them from the server and prevent them from rejoining."
        confirmLabel="Ban"
        loadingLabel="Banning..."
        onConfirm={async () => {
          if (!banTarget) return;
          const res = await apiFetch(`/api/v1/servers/${serverId}/bans/${banTarget.user_id}`, {
            method: 'POST',
          });
          if (!res.ok) {
            const data = await safeJson<{ error?: string }>(res);
            throw new Error(data?.error || 'Ban failed');
          }
          useMemberStore.getState().removeMember(banTarget.user_id);
        }}
      />

      <ConfirmActionModal
        isOpen={!!kickTarget}
        onClose={() => setKickTarget(null)}
        title={`Kick ${kickTarget?.display_name || kickTarget?.username || 'User'}`}
        message="This will remove them from the server. They can rejoin with a new invite."
        confirmLabel="Kick"
        loadingLabel="Kicking..."
        onConfirm={async () => {
          if (!kickTarget) return;
          const res = await apiFetch(`/api/v1/servers/${serverId}/members/${kickTarget.user_id}`, {
            method: 'DELETE',
          });
          if (!res.ok) {
            const data = await safeJson<{ error?: string }>(res);
            throw new Error(data?.error || 'Kick failed');
          }
          useMemberStore.getState().removeMember(kickTarget.user_id);
        }}
      />
    </div>
  );
};

export default MemberListPanel;
