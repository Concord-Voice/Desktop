import React, { useState } from 'react';
import { ServerMember, useMemberStore } from '../../stores/memberStore';
import { usePermissionStore } from '../../stores/permissionStore';
import { Permissions } from '../../utils/permissions';
import { apiFetch } from '../../services/apiClient';
import ContextMenu from '../ui/ContextMenu';

// Available assignable roles — extend this array as custom roles are added
const AVAILABLE_ROLES: { value: string; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
];

interface MemberContextMenuProps {
  member: ServerMember;
  position: { x: number; y: number };
  serverId: string;
  ownerUserId: string;
  onClose: () => void;
  onViewProfile: () => void;
}

const MemberContextMenu: React.FC<MemberContextMenuProps> = ({
  member,
  position,
  serverId,
  ownerUserId,
  onClose,
  onViewProfile,
}) => {
  const [isUpdatingRole, setIsUpdatingRole] = useState(false);
  const [showRolePicker, setShowRolePicker] = useState(false);
  const [rolePickerClosing, setRolePickerClosing] = useState(false);

  const hasServerPerm = usePermissionStore((s) => s.hasServerPermission);
  const targetIsOwner = member.user_id === ownerUserId;

  // Can assign roles if user has MANAGE_ROLES_ASSIGN and target is not the owner
  const canAssignRole = hasServerPerm(serverId, Permissions.MANAGE_ROLES_ASSIGN) && !targetIsOwner;

  // Can ban if user has BAN permission and target is not the owner
  const canBan = hasServerPerm(serverId, Permissions.BAN) && !targetIsOwner;

  const handleRoleSelect = async (newRole: string) => {
    if (newRole === member.role || isUpdatingRole) return;
    setIsUpdatingRole(true);

    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/members/${member.user_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        let detail = '';
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) detail = `: ${data.error}`;
        } catch {
          /* ignore parse errors */
        }
        throw new Error(`Role update failed (${res.status})${detail}`);
      }

      // Update the member's role in the local store only after confirmed success
      const members = useMemberStore.getState().members;
      const updatedMembers = members.map((m) =>
        m.user_id === member.user_id ? { ...m, role: newRole as ServerMember['role'] } : m
      );
      useMemberStore.setState({ members: updatedMembers });

      onClose();
    } catch (error) {
      console.error('Failed to update role:', error);
    } finally {
      setIsUpdatingRole(false);
    }
  };

  return (
    <ContextMenu position={position} onClose={onClose}>
      <ContextMenu.Header>
        <span
          style={{
            fontWeight: 600,
            color: 'var(--text-primary)',
            fontSize: 'calc(14px * var(--font-scale, 1))',
          }}
        >
          {member.display_name || member.username}
        </span>
      </ContextMenu.Header>

      <ContextMenu.Separator />

      {/* View Profile — always available */}
      <ContextMenu.Item
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="5" r="3" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M2 14c0-2.76 2.69-5 6-5s6 2.24 6 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        }
        label="View Profile"
        onClick={() => {
          onViewProfile();
          onClose();
        }}
      />

      {/* Send DM — always visible, disabled (no backend yet) */}
      <ContextMenu.Item
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 3h12v9H4l-2 2V3z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        }
        label="Send DM"
        disabled
        onClick={() => {}}
      />

      {/* Assign Role — only for server owner, not on the owner themselves */}
      {canAssignRole && (
        <>
          <ContextMenu.Separator />
          <div className="ctx-menu-item-wrapper">
            <ContextMenu.Item
              icon={
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 1l2 4h4l-3.5 3 1.5 4.5L8 10l-4 2.5L5.5 8 2 5h4l2-4z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              }
              label={isUpdatingRole ? 'Updating...' : 'Assign Role'}
              disabled={isUpdatingRole}
              hasSubMenu
              onClick={() => {
                if (showRolePicker) {
                  setRolePickerClosing(true);
                  setTimeout(() => {
                    setShowRolePicker(false);
                    setRolePickerClosing(false);
                  }, 150);
                } else {
                  setShowRolePicker(true);
                }
              }}
            />

            {/* Role picker flyout submenu */}
            {showRolePicker && !isUpdatingRole && (
              <ContextMenu.SubMenu closing={rolePickerClosing}>
                {AVAILABLE_ROLES.map((role) => {
                  const isCurrent = member.role === role.value;
                  return (
                    <ContextMenu.Item
                      key={role.value}
                      icon={
                        <span style={{ width: 16, textAlign: 'center', fontSize: 12 }}>
                          {isCurrent ? '✓' : ''}
                        </span>
                      }
                      label={role.label}
                      disabled={isCurrent}
                      onClick={() => handleRoleSelect(role.value)}
                    />
                  );
                })}
              </ContextMenu.SubMenu>
            )}
          </div>
        </>
      )}

      {/* Ban — visible to owner/admin, disabled (no backend yet) */}
      {canBan && (
        <ContextMenu.Item
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M3.75 3.75l8.5 8.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          }
          label="Ban"
          danger
          disabled
          onClick={() => {}}
        />
      )}
    </ContextMenu>
  );
};

export default MemberContextMenu;
