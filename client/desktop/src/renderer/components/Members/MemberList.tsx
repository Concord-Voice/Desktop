import React, { useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useUserStore } from '../../stores/userStore';
import { useMemberStore, ServerMember, PresenceStatus } from '../../stores/memberStore';
import MemberProfileCard from './MemberProfileCard';
import MemberContextMenu from './MemberContextMenu';
import './MemberList.css';

const MemberList: React.FC = () => {
  const accessToken = useAuthStore((state) => state.accessToken);
  const activeServerId = useServerStore((state) => state.activeServerId);
  const servers = useServerStore((state) => state.servers);
  const activeServer = servers.find((s) => s.id === activeServerId) || null;
  const selfUser = useUserStore((state) => state.user);
  const members = useMemberStore((state) => state.members);
  const onlineUserIds = useMemberStore((state) => state.onlineUserIds);
  const userStatuses = useMemberStore((state) => state.userStatuses);
  const lastSeenByUser = useMemberStore((state) => state.lastSeenByUser);
  const selfStatus = useMemberStore((state) => state.selfStatus);
  const isLoading = useMemberStore((state) => state.isLoading);
  const error = useMemberStore((state) => state.error);
  const fetchMembers = useMemberStore((state) => state.fetchMembers);
  const clearMembers = useMemberStore((state) => state.clearMembers);

  const [selectedMember, setSelectedMember] = useState<{
    member: ServerMember;
    position: { x: number; y: number };
  } | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    member: ServerMember;
    position: { x: number; y: number };
  } | null>(null);

  // Fetch members when active server changes
  useEffect(() => {
    if (activeServerId && accessToken) {
      fetchMembers(activeServerId, accessToken);
    } else {
      clearMembers();
    }
  }, [activeServerId, accessToken, fetchMembers, clearMembers]);

  // Presence is handled globally in useWebSocket (presence_snapshot + presence events)

  const handleMemberClick = useCallback(
    (e: React.MouseEvent, member: ServerMember) => {
      setSelectedMember({
        member,
        position: { x: e.clientX, y: e.clientY },
      });
    },
    []
  );

  const handleMemberContextMenu = useCallback(
    (e: React.MouseEvent, member: ServerMember) => {
      e.preventDefault();
      setContextMenu({
        member,
        position: { x: e.clientX, y: e.clientY },
      });
    },
    []
  );

  // Get status for a member (with fallback)
  // For the self user, use selfStatus as the source of truth
  const getMemberStatus = (userId: string): PresenceStatus => {
    if (selfUser && userId === selfUser.id) {
      return selfStatus;
    }
    return userStatuses.get(userId) || (onlineUserIds.has(userId) ? 'online' : 'offline');
  };

  // Sort: online first, dnd second, away third, offline/invisible last, then alphabetical
  const sortMembers = (list: ServerMember[]) =>
    [...list].sort((a, b) => {
      const statusOrder: Record<PresenceStatus, number> = { online: 0, dnd: 1, invisible: 2, offline: 2 };
      const aStatus = getMemberStatus(a.user_id);
      const bStatus = getMemberStatus(b.user_id);
      const aOrder = statusOrder[aStatus];
      const bOrder = statusOrder[bStatus];
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.username.localeCompare(b.username);
    });

  // Group members by role
  const owners = sortMembers(members.filter((m) => m.role === 'owner'));
  const admins = sortMembers(members.filter((m) => m.role === 'admin'));
  const regularMembers = sortMembers(members.filter((m) => m.role === 'member'));

  const renderMemberItem = (member: ServerMember) => {
    const status = getMemberStatus(member.user_id);
    return (
      <div
        key={member.user_id}
        className={`member-item ${status}`}
        onClick={(e) => handleMemberClick(e, member)}
        onContextMenu={(e) => handleMemberContextMenu(e, member)}
        title={member.display_name || member.username}
      >
        <div className="member-avatar">
          {member.avatar_url ? (
            <img
              src={member.avatar_url}
              alt={member.username}
              className="member-avatar-img"
            />
          ) : (
            <span className="member-avatar-initial">
              {member.username.charAt(0).toUpperCase()}
            </span>
          )}
          <span
            className={`member-status-dot ${status}`}
          />
        </div>
        <span className="member-username">
          {member.display_name || member.username}
        </span>
      </div>
    );
  };

  const renderGroup = (label: string, groupMembers: ServerMember[]) => {
    if (groupMembers.length === 0) return null;
    return (
      <div className="member-group" key={label}>
        <div className="member-group-header">
          <span>
            {label} — {groupMembers.length}
          </span>
        </div>
        {groupMembers.map(renderMemberItem)}
      </div>
    );
  };

  return (
    <div className="member-list">
      <div className="member-list-header">
        <h3>Members</h3>
      </div>

      {/* Loading State */}
      {isLoading && members.length === 0 && (
        <div className="member-list-skeletons">
          <div className="member-skeleton" />
          <div className="member-skeleton" />
          <div className="member-skeleton" />
          <div className="member-skeleton" />
          <div className="member-skeleton" />
        </div>
      )}

      {/* Error State */}
      {error && members.length === 0 && !isLoading && (
        <div className="member-list-error">
          <p>{error}</p>
          <button
            onClick={() =>
              activeServerId &&
              accessToken &&
              fetchMembers(activeServerId, accessToken)
            }
            className="retry-btn"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && members.length === 0 && (
        <div className="member-list-empty">
          <p>No members</p>
        </div>
      )}

      {/* Member Groups */}
      {members.length > 0 && (
        <>
          {renderGroup('OWNER', owners)}
          {renderGroup('ADMINS', admins)}
          {renderGroup('MEMBERS', regularMembers)}
        </>
      )}

      {/* Profile Card */}
      {selectedMember && (
        <MemberProfileCard
          member={selectedMember.member}
          status={getMemberStatus(selectedMember.member.user_id)}
          lastSeen={lastSeenByUser.get(selectedMember.member.user_id)}
          position={selectedMember.position}
          onClose={() => setSelectedMember(null)}
        />
      )}

      {/* Context Menu */}
      {contextMenu && activeServer && (
        <MemberContextMenu
          member={contextMenu.member}
          position={contextMenu.position}
          currentUserRole={activeServer.role}
          serverId={activeServer.id}
          onClose={() => setContextMenu(null)}
          onViewProfile={() => {
            setSelectedMember({
              member: contextMenu.member,
              position: contextMenu.position,
            });
          }}
        />
      )}
    </div>
  );
};

export default MemberList;
