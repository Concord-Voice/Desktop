import React, { useState, useEffect, useCallback } from 'react';
import Modal from '../ui/Modal';
import ImageCropEditor from '../ui/ImageCropEditor';
import LoadingSpinner from '../Auth/LoadingSpinner';
import RoleEditorPanel from './RoleEditorPanel';
import MemberListPanel from './MemberListPanel';
import { useServerStore } from '../../stores/serverStore';
import { useInviteStore } from '../../stores/inviteStore';
import { usePermissionStore } from '../../stores/permissionStore';
import { useMemberStore } from '../../stores/memberStore';
import { Permissions } from '../../utils/permissions';
import { apiFetch } from '../../services/apiClient';
import { useImageUpload } from '../../hooks/useImageUpload';
import IconUploadArea from './IconUploadArea';
import BannerUploadArea from './BannerUploadArea';
import {
  MAX_ICON_SIZE,
  MAX_BANNER_SIZE,
  ALLOWED_TYPES,
  NAME_MIN,
  NAME_MAX,
  type ServerFormErrors,
} from './serverConstants';
import type { ServerWithRole, ServerInviteWithCreator, Role } from '../../types/server';
import './ServerSettingsModal.css';

const EMPTY_INVITES: ServerInviteWithCreator[] = [];
const EMPTY_ROLES: Role[] = [];

interface ServerSettingsModalProps {
  isOpen: boolean;
  server: ServerWithRole;
  onClose: () => void;
}

type SettingsTab = 'general' | 'roles' | 'members';

const ServerSettingsModal: React.FC<ServerSettingsModalProps> = ({ isOpen, server, onClose }) => {
  const [name, setName] = useState(server.name);
  const [errors, setErrors] = useState<ServerFormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [isCreatingInvite, setIsCreatingInvite] = useState(false);

  const icon = useImageUpload({
    maxSize: MAX_ICON_SIZE,
    allowedTypes: ALLOWED_TYPES,
    onError: (msg) => setErrors((prev) => ({ ...prev, icon: msg })),
    initialUrl: server.icon_url,
  });

  const banner = useImageUpload({
    maxSize: MAX_BANNER_SIZE,
    allowedTypes: ALLOWED_TYPES,
    onError: (msg) => setErrors((prev) => ({ ...prev, banner: msg })),
    initialUrl: server.banner_url,
  });

  // Tab state
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  const hasServerPerm = usePermissionStore((s) => s.hasServerPermission);
  const canManageInvites = hasServerPerm(server.id, Permissions.INVITE);
  const canManageRoles = hasServerPerm(server.id, Permissions.MANAGE_ROLES);
  const canAssignRoles = hasServerPerm(server.id, Permissions.MANAGE_ROLES_ASSIGN);
  const invites = useInviteStore((state) => state.invites[server.id] ?? EMPTY_INVITES);
  const fetchInvites = useInviteStore((state) => state.fetchInvites);
  const createInvite = useInviteStore((state) => state.createInvite);

  // Permission store - roles
  const serverRoles = usePermissionStore((s) => s.serverRoles[server.id] ?? EMPTY_ROLES);
  const fetchRoles = usePermissionStore((s) => s.fetchRoles);
  const createRole = usePermissionStore((s) => s.createRole);
  const updateRole = usePermissionStore((s) => s.updateRole);
  const deleteRole = usePermissionStore((s) => s.deleteRole);
  const assignRole = usePermissionStore((s) => s.assignRole);
  const unassignRole = usePermissionStore((s) => s.unassignRole);

  // Member store
  const members = useMemberStore((s) => s.members);
  const fetchMembers = useMemberStore((s) => s.fetchMembers);

  // Find first active (non-revoked, non-expired) invite
  const activeInvite = invites.find((inv) => {
    if (inv.is_revoked) return false;
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return false;
    if (inv.max_uses !== null && inv.use_count >= inv.max_uses) return false;
    return true;
  });

  // Reset form when server changes
  useEffect(() => {
    setName(server.name);
    icon.reset(server.icon_url || null);
    banner.reset(server.banner_url || null);
    setErrors({});
    setIsSubmitting(false);
    setSuccessMessage(null);
    setInviteCopied(false);
    setIsCreatingInvite(false);
    setActiveTab('general');
    // eslint-disable-next-line @eslint-react/exhaustive-deps -- banner/icon are local state; including them causes resets on form interaction
  }, [server]);

  // Fetch invites when modal opens for owner/admin
  useEffect(() => {
    if (isOpen && canManageInvites) {
      fetchInvites(server.id);
    }
  }, [isOpen, canManageInvites, server.id, fetchInvites]);

  // Fetch roles when roles tab is active
  useEffect(() => {
    if (isOpen && activeTab === 'roles' && canManageRoles) {
      fetchRoles(server.id);
    }
  }, [isOpen, activeTab, canManageRoles, server.id, fetchRoles]);

  // Fetch members when members tab is active
  useEffect(() => {
    if (isOpen && activeTab === 'members' && canAssignRoles) {
      fetchMembers(server.id);
      fetchRoles(server.id);
    }
  }, [isOpen, activeTab, canAssignRoles, server.id, fetchMembers, fetchRoles]);

  const handleClose = () => {
    if (!isSubmitting) {
      onClose();
    }
  };

  const validateForm = (): boolean => {
    const newErrors: ServerFormErrors = {};
    const trimmed = name.trim();

    if (!trimmed) {
      newErrors.name = 'Server name is required';
    } else if (trimmed.length < NAME_MIN) {
      newErrors.name = `Server name must be at least ${NAME_MIN} characters`;
    } else if (trimmed.length > NAME_MAX) {
      newErrors.name = `Server name must be at most ${NAME_MAX} characters`;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setSuccessMessage(null);

    if (!validateForm()) return;

    setIsSubmitting(true);

    try {
      const body: { name: string; icon_url?: string | null; banner_url?: string | null } = {
        name: name.trim(),
      };

      if (icon.removed) {
        body.icon_url = null;
      } else if (icon.imageUrl && icon.imageUrl !== server.icon_url) {
        body.icon_url = icon.imageUrl;
      }

      if (banner.removed) {
        body.banner_url = null;
      } else if (banner.imageUrl && banner.imageUrl !== server.banner_url) {
        body.banner_url = banner.imageUrl;
      }

      const response = await apiFetch(`/api/v1/servers/${server.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to update server');
      }

      useServerStore.getState().updateServer(server.id, {
        name: data.server.name,
        icon_url: data.server.icon_url,
        banner_url: data.server.banner_url,
        updated_at: data.server.updated_at,
      });

      setSuccessMessage('Server updated successfully!');

      setTimeout(() => {
        onClose();
      }, 800);
    } catch (error) {
      setErrors({
        general:
          error instanceof Error ? error.message : 'Failed to update server. Please try again.',
      });
      setIsSubmitting(false);
    }
  };

  // Roles tab handlers
  const handleCreateRole = useCallback(async () => {
    return await createRole(server.id, {
      name: 'New Role',
      color: '#99aab5',
      permissions: '0',
    });
  }, [createRole, server.id]);

  const handleSaveRole = useCallback(
    async (
      roleId: string,
      data: {
        name: string;
        color: string;
        emoji: string;
        permissions: string;
        display_separately: boolean;
        mentionable: boolean;
      }
    ) => {
      await updateRole(server.id, roleId, data);
    },
    [server.id, updateRole]
  );

  const handleDeleteRole = useCallback(
    async (roleId: string) => {
      await deleteRole(server.id, roleId);
    },
    [server.id, deleteRole]
  );

  // Members tab handlers
  const handleToggleRole = useCallback(
    async (userId: string, roleId: string, hasRole: boolean) => {
      if (hasRole) {
        await unassignRole(server.id, userId, roleId);
      } else {
        await assignRole(server.id, userId, roleId);
      }
      // Re-fetch members to update role badges
      await fetchMembers(server.id);
    },
    [server.id, assignRole, unassignRole, fetchMembers]
  );

  // Filter out non-default roles for assignment (default role is auto-assigned)
  const assignableRoles = serverRoles.filter((r) => !r.is_default);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Server Settings" width="large">
      <div className="settings-tabs">
        <button
          className={`settings-tab ${activeTab === 'general' ? 'active' : ''}`}
          onClick={() => setActiveTab('general')}
        >
          General
        </button>
        {canManageRoles && (
          <button
            className={`settings-tab ${activeTab === 'roles' ? 'active' : ''}`}
            onClick={() => setActiveTab('roles')}
          >
            Roles
          </button>
        )}
        {canAssignRoles && (
          <button
            className={`settings-tab ${activeTab === 'members' ? 'active' : ''}`}
            onClick={() => setActiveTab('members')}
          >
            Members
          </button>
        )}
      </div>

      {/* General Tab */}
      {activeTab === 'general' && (
        <form className="server-settings-form" onSubmit={handleSubmit}>
          <IconUploadArea
            preview={icon.preview}
            error={errors.icon}
            onClick={icon.handleClick}
            onKeyDown={icon.handleKeyDown}
            onRemove={icon.handleRemove}
            onFileChange={icon.handleChange}
            fileInputRef={icon.fileInputRef}
          />

          {/* Banner Upload */}
          <BannerUploadArea
            preview={banner.preview}
            error={errors.banner}
            onClick={banner.handleClick}
            onKeyDown={banner.handleKeyDown}
            onRemove={banner.handleRemove}
            onFileChange={banner.handleChange}
            fileInputRef={banner.fileInputRef}
            hint="PNG, JPEG, GIF, WebP — max 2MB. Optional."
          />

          {/* Server Name */}
          <div className="form-group">
            <label htmlFor="modal-server-name" className="form-label">
              Server Name
            </label>
            <input
              id="modal-server-name"
              type="text"
              className={`form-input ${errors.name ? 'error' : ''}`}
              placeholder="My Awesome Server"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
              }}
              disabled={isSubmitting}
              autoFocus
              maxLength={NAME_MAX}
            />
            {errors.name && <span className="form-error">{errors.name}</span>}
            <span className="form-hint">
              {name.trim().length}/{NAME_MAX} characters
            </span>
          </div>

          {/* Invite Code Section */}
          {canManageInvites && (
            <div className="invite-section">
              <span className="form-label">Invite Code</span>
              {activeInvite ? (
                <div className="invite-code-row">
                  <code className="invite-code-display">{activeInvite.code}</code>
                  <button
                    type="button"
                    className="invite-copy-btn"
                    onClick={() => {
                      navigator.clipboard.writeText(activeInvite.code);
                      setInviteCopied(true);
                      setTimeout(() => setInviteCopied(false), 2000);
                    }}
                  >
                    {inviteCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="invite-generate-btn"
                  disabled={isCreatingInvite}
                  onClick={async () => {
                    setIsCreatingInvite(true);
                    await createInvite(server.id);
                    setIsCreatingInvite(false);
                  }}
                >
                  {isCreatingInvite ? (
                    <>
                      Generating...
                      <LoadingSpinner size="small" inline />
                    </>
                  ) : (
                    'Generate Invite Code'
                  )}
                </button>
              )}
              <span className="form-hint">Invites default to 1 use, expire in 24 hours.</span>
            </div>
          )}

          {/* General Error */}
          {errors.general && (
            <div className="form-error-banner">
              <span>{errors.general}</span>
            </div>
          )}

          {/* Success Message */}
          {successMessage && (
            <div className="form-success-banner">
              <span>{successMessage}</span>
            </div>
          )}

          {/* Buttons */}
          <div className="server-settings-actions">
            <button
              type="button"
              className="server-settings-cancel-btn"
              onClick={handleClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="server-settings-submit-btn"
              disabled={isSubmitting || !!successMessage}
            >
              {isSubmitting ? (
                <>
                  Saving...
                  <LoadingSpinner size="small" inline />
                </>
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </form>
      )}

      {/* Roles Tab */}
      {activeTab === 'roles' && canManageRoles && (
        <RoleEditorPanel
          roles={serverRoles}
          onCreateRole={handleCreateRole}
          onSaveRole={handleSaveRole}
          onDeleteRole={handleDeleteRole}
        />
      )}

      {/* Members Tab */}
      {activeTab === 'members' && canAssignRoles && (
        <MemberListPanel
          members={members}
          assignableRoles={assignableRoles}
          onToggleRole={handleToggleRole}
          serverId={server.id}
          ownerUserId={server.owner_id}
        />
      )}

      {/* Icon Crop Editor */}
      <ImageCropEditor
        isOpen={icon.showCrop}
        onClose={icon.handleCropCancel}
        onConfirm={icon.handleCropConfirm}
        imageFile={icon.pendingFile}
        title="Crop Server Icon"
        cropShape={{ type: 'circle' }}
        output={{ width: 512, height: 512, quality: 0.9 }}
        upload={{
          endpoint: '/api/v1/media/upload/server-icon',
          extraFields: { server_id: server.id },
        }}
      />

      {/* Banner Crop Editor */}
      <ImageCropEditor
        isOpen={banner.showCrop}
        onClose={banner.handleCropCancel}
        onConfirm={banner.handleCropConfirm}
        imageFile={banner.pendingFile}
        title="Crop Server Banner"
        cropShape={{ type: 'rectangle' }}
        output={{ width: 1200, height: 240, quality: 0.9 }}
        upload={{
          endpoint: '/api/v1/media/upload/server-banner',
          extraFields: { server_id: server.id },
        }}
      />
    </Modal>
  );
};

export default ServerSettingsModal;
