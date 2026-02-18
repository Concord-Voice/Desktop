import React, { useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useServerStore } from '../../stores/serverStore';
import { useMemberStore, ServerMember } from '../../stores/memberStore';
import { getWebSocketService } from '../../services/websocketService';
import MemberProfileCard from './MemberProfileCard';
import './MemberList.css';

const MemberList: React.FC = () => {
  const accessToken = useAuthStore((state) => state.accessToken);
  const activeServerId = useServerStore((state) => state.activeServerId);
  const members = useMemberStore((state) => state.members);
  const onlineUserIds = useMemberStore((state) => state.onlineUserIds);
  const isLoading = useMemberStore((state) => state.isLoading);
  const error = useMemberStore((state) => state.error);
  const fetchMembers = useMemberStore((state) => state.fetchMembers);
  const clearMembers = useMemberStore((state) => state.clearMembers);
  const setOnlineUsers = useMemberStore((state) => state.setOnlineUsers);
  const setUserOnline = useMemberStore((state) => state.setUserOnline);
  const setUserOffline = useMemberStore((state) => state.setUserOffline);

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
      const userIds = msg.data.online_user_ids as string[];
      setOnlineUsers(userIds);
    });

    const unsubPresence = ws.on('presence', (msg) => {
      const userId = msg.data.user_id as string;
      const status = msg.data.status as string;
      if (status === 'online') {
        setUserOnline(userId);
      } else {
        setUserOffline(userId);
      }
    });

    return () => {
      unsubSnapshot();
      unsubPresence();
    };
  }, [setOnlineUsers, setUserOnline, setUserOffline]);

  const handleMemberClick = useCallback(
    (e: React.MouseEvent, member: ServerMember) => {
      setSelectedMember({
        member,
        position: { x: e.clientX, y: e.clientY },
      });
    },
    []
  );

  // Sort: online first, then alphabetical
  const sortMembers = (list: ServerMember[]) =>
    [...list].sort((a, b) => {
      const aOnline = onlineUserIds.has(a.user_id) ? 0 : 1;
      const bOnline = onlineUserIds.has(b.user_id) ? 0 : 1;
      if (aOnline !== bOnline) return aOnline - bOnline;
      return a.username.localeCompare(b.username);
    });

  // Group members by role
  const owners = sortMembers(members.filter((m) => m.role === 'owner'));
  const admins = sortMembers(members.filter((m) => m.role === 'admin'));
  const regularMembers = sortMembers(members.filter((m) => m.role === 'member'));

  const renderMemberItem = (member: ServerMember) => {
    const isOnline = onlineUserIds.has(member.user_id);
    return (
      <div
        key={member.user_id}
        className={`member-item ${isOnline ? '' : 'offline'}`}
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
            className={`member-status-dot ${isOnline ? 'online' : 'offline'}`}
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
          isOnline={onlineUserIds.has(selectedMember.member.user_id)}
          position={selectedMember.position}
          onClose={() => setSelectedMember(null)}
        />
      )}
    </div>
  );
};

export default MemberList;
