import React, { useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useUserStore } from '../../stores/userStore';
import { useMemberStore, ServerMember, PresenceStatus } from '../../stores/memberStore';
import { getWebSocketService } from '../../services/websocketService';
import MemberProfileCard from './MemberProfileCard';
import './MemberList.css';

const MemberList: React.FC = () => {
  const accessToken = useAuthStore((state) => state.accessToken);
  const activeServerId = useServerStore((state) => state.activeServerId);
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
  const setOnlineUsers = useMemberStore((state) => state.setOnlineUsers);
  const setUserStatus = useMemberStore((state) => state.setUserStatus);
  const setUserLastSeen = useMemberStore((state) => state.setUserLastSeen);
  const setPresenceSnapshot = useMemberStore((state) => state.setPresenceSnapshot);

  const [selectedMember, setSelectedMember] = useState<{
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

  // Register WebSocket presence handlers
  useEffect(() => {
    const ws = getWebSocketService();

    const unsubSnapshot = ws.on('presence_snapshot', (msg) => {
      // Handle enhanced format with per-user status
      if (msg.data.users && Array.isArray(msg.data.users)) {
        setPresenceSnapshot(msg.data.users as Array<{ user_id: string; status: string }>);
      } else if (msg.data.online_user_ids) {
        // Backward compatibility
        const userIds = msg.data.online_user_ids as string[];
        setOnlineUsers(userIds);
      }
    });

    const unsubPresence = ws.on('presence', (msg) => {
      const userId = msg.data.user_id as string;
      const status = msg.data.status as PresenceStatus;
      const timestamp = msg.data.timestamp as number | undefined;

      // For the self user, the server broadcasts "offline" for invisible
      // and the real status for dnd — but we trust selfStatus locally
      // so skip overriding the self user's status from broadcast
      const selfId = useUserStore.getState().user?.id;
      if (userId === selfId) {
        // Don't override — selfStatus is the source of truth for self
        return;
      }

      setUserStatus(userId, status);

      if (status === 'offline' && timestamp) {
        setUserLastSeen(userId, timestamp);
      }
    });

    return () => {
      unsubSnapshot();
      unsubPresence();
    };
  }, [setOnlineUsers, setUserStatus, setUserLastSeen, setPresenceSnapshot]);

  const handleMemberClick = useCallback(
    (e: React.MouseEvent, member: ServerMember) => {
      setSelectedMember({
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
    </div>
  );
};

export default MemberList;
