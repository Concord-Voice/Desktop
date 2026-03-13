import React, { useEffect, useState, useMemo, useCallback } from 'react';
import Modal from '../ui/Modal';
import PermissionGrid from '../Permissions/PermissionGrid';
import { usePermissionStore, ChannelOverride } from '../../stores/permissionStore';
import { useMemberStore } from '../../stores/memberStore';
import { ChannelGroup } from '../../types/chat';
import { parsePermissions, countBits } from '../../utils/permissions';
import './CategorySettingsModal.css';

interface CategorySettingsModalProps {
  isOpen: boolean;
  category: ChannelGroup;
  serverId: string;
  onClose: () => void;
}

const CategorySettingsModal: React.FC<CategorySettingsModalProps> = ({
  isOpen,
  category,
  serverId,
  onClose,
}) => {
  const fetchCategoryOverrides = usePermissionStore((s) => s.fetchCategoryOverrides);
  const upsertCategoryOverride = usePermissionStore((s) => s.upsertCategoryOverride);
  const deleteCategoryOverride = usePermissionStore((s) => s.deleteCategoryOverride);
  const fetchRoles = usePermissionStore((s) => s.fetchRoles);
  const serverRoles = usePermissionStore((s) => s.serverRoles);
  const channelOverrides = usePermissionStore((s) => s.channelOverrides);
  const members = useMemberStore((s) => s.members);

  const [selectedOverrideId, setSelectedOverrideId] = useState<string | null>(null);
  const [editAllow, setEditAllow] = useState<bigint>(0n);
  const [editDeny, setEditDeny] = useState<bigint>(0n);

  // Add override form state
  const [addTargetType, setAddTargetType] = useState<'role' | 'user'>('role');
  const [addTargetId, setAddTargetId] = useState('');
  const [addAllow, setAddAllow] = useState<bigint>(0n);
  const [addDeny, setAddDeny] = useState<bigint>(0n);

  const storeKey = `category:${category.id}`;
  const overrides: ChannelOverride[] = channelOverrides[storeKey] ?? [];
  const roles = serverRoles[serverId] ?? [];

  useEffect(() => {
    if (isOpen) {
      fetchCategoryOverrides(category.id);
      fetchRoles(serverId);
    }
  }, [isOpen, category.id, serverId, fetchCategoryOverrides, fetchRoles]);

  // Reset selection when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedOverrideId(null);
      setEditAllow(0n);
      setEditDeny(0n);
      setAddTargetType('role');
      setAddTargetId('');
      setAddAllow(0n);
      setAddDeny(0n);
    }
  }, [isOpen]);

  const roleOverrides = useMemo(
    () => overrides.filter((o) => o.target_type === 'role'),
    [overrides]
  );
  const userOverrides = useMemo(
    () => overrides.filter((o) => o.target_type === 'user'),
    [overrides]
  );

  const getTargetName = useCallback(
    (override: ChannelOverride): string => {
      if (override.target_type === 'role') {
        const role = roles.find((r) => r.id === override.target_id);
        return role?.name ?? 'Unknown Role';
      }
      const member = members.find((m) => m.user_id === override.target_id);
      return member?.display_name ?? member?.username ?? 'Unknown User';
    },
    [roles, members]
  );

  const handleSelectOverride = useCallback((override: ChannelOverride) => {
    setSelectedOverrideId(override.id);
    setEditAllow(parsePermissions(override.allow));
    setEditDeny(parsePermissions(override.deny));
  }, []);

  const handleSaveOverride = useCallback(
    async (override: ChannelOverride) => {
      await upsertCategoryOverride(category.id, {
        target_type: override.target_type,
        target_id: override.target_id,
        allow: editAllow.toString(),
        deny: editDeny.toString(),
      });
      setSelectedOverrideId(null);
    },
    [category.id, editAllow, editDeny, upsertCategoryOverride]
  );

  const handleDeleteOverride = useCallback(
    async (overrideId: string) => {
      await deleteCategoryOverride(category.id, overrideId);
      if (selectedOverrideId === overrideId) {
        setSelectedOverrideId(null);
      }
    },
    [category.id, deleteCategoryOverride, selectedOverrideId]
  );

  const handleAddOverride = useCallback(async () => {
    if (!addTargetId) return;
    await upsertCategoryOverride(category.id, {
      target_type: addTargetType,
      target_id: addTargetId,
      allow: addAllow.toString(),
      deny: addDeny.toString(),
    });
    setAddTargetId('');
    setAddAllow(0n);
    setAddDeny(0n);
  }, [category.id, addTargetType, addTargetId, addAllow, addDeny, upsertCategoryOverride]);

  const selectedOverride = useMemo(
    () => overrides.find((o) => o.id === selectedOverrideId) ?? null,
    [overrides, selectedOverrideId]
  );

  const renderOverrideItem = (override: ChannelOverride) => {
    const isSelected = selectedOverrideId === override.id;
    const allowCount = countBits(override.allow);
    const denyCount = countBits(override.deny);

    return (
      <div
        key={override.id}
        className={`override-item${isSelected ? ' selected' : ''}`}
        onClick={() => handleSelectOverride(override)}
      >
        <div className="override-target">
          <div>
            <div className="override-target-name">{getTargetName(override)}</div>
            <div className="override-target-type">{override.target_type}</div>
          </div>
        </div>
        <div className="override-summary">
          {allowCount > 0 && <span className="override-allow-count">{allowCount} allowed</span>}
          {denyCount > 0 && <span className="override-deny-count">{denyCount} denied</span>}
        </div>
        <button
          className="override-delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            handleDeleteOverride(override.id);
          }}
          aria-label="Delete override"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M12.67 4v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Category Permissions — ${category.name}`}
      width="large"
    >
      {/* Override List */}
      {roleOverrides.length > 0 && (
        <>
          <div className="section-header">Role Overrides</div>
          <div className="override-list">{roleOverrides.map(renderOverrideItem)}</div>
        </>
      )}

      {userOverrides.length > 0 && (
        <>
          <div className="section-header">User Overrides</div>
          <div className="override-list">{userOverrides.map(renderOverrideItem)}</div>
        </>
      )}

      {overrides.length === 0 && (
        <div className="no-overrides">No permission overrides configured for this category.</div>
      )}

      {/* Edit Selected Override */}
      {selectedOverride && (
        <>
          <div className="section-header">Editing: {getTargetName(selectedOverride)}</div>
          <PermissionGrid
            value={editAllow}
            onChange={setEditAllow}
            deny={editDeny}
            onDenyChange={setEditDeny}
            mode="override"
          />
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button
              className="add-override-btn"
              onClick={() => handleSaveOverride(selectedOverride)}
            >
              Save Override
            </button>
            <button
              className="add-override-btn"
              style={{ opacity: 0.7 }}
              onClick={() => setSelectedOverrideId(null)}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {/* Add Override Section */}
      {!selectedOverride && (
        <div className="add-override-section">
          <div className="section-header">Add Override</div>
          <div className="add-override-row">
            <select
              className="add-override-select"
              value={addTargetType}
              onChange={(e) => {
                setAddTargetType(e.target.value as 'role' | 'user');
                setAddTargetId('');
              }}
            >
              <option value="role">Role</option>
              <option value="user">User</option>
            </select>
            <select
              className="add-override-select"
              value={addTargetId}
              onChange={(e) => setAddTargetId(e.target.value)}
            >
              <option value="">Select {addTargetType === 'role' ? 'a role' : 'a user'}...</option>
              {addTargetType === 'role'
                ? roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))
                : members.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.display_name ?? member.username}
                    </option>
                  ))}
            </select>
          </div>
          <PermissionGrid
            value={addAllow}
            onChange={setAddAllow}
            deny={addDeny}
            onDenyChange={setAddDeny}
            mode="override"
          />
          <button className="add-override-btn" disabled={!addTargetId} onClick={handleAddOverride}>
            Add Override
          </button>
        </div>
      )}
    </Modal>
  );
};

export default CategorySettingsModal;
