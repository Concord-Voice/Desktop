import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useUserStore } from '../../stores/userStore';
import { useMemberStore, ServerMember, PresenceStatus } from '../../stores/memberStore';
import MemberItem from './MemberItem';
import MemberProfileCard from './MemberProfileCard';
import MemberContextMenu from './MemberContextMenu';
import UserProfileModal from './UserProfileModal';
import './MemberList.css';

const MemberList: React.FC = () => {
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
    userId: string;
    position: { x: number; y: number };
  } | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    member: ServerMember;
    position: { x: number; y: number };
  } | null>(null);

  const [fullProfileUserId, setFullProfileUserId] = useState<string | null>(null);

  // Derive live member data from store (not stale snapshots)
  const selectedMemberData = selectedMember
    ? (members.find((m) => m.user_id === selectedMember.userId) ?? null)
    : null;

  const fullProfileMemberData = fullProfileUserId
    ? (members.find((m) => m.user_id === fullProfileUserId) ?? null)
    : null;

  // Fetch members when active server changes.
  // Guard prevents StrictMode double-mount from firing duplicate HTTP requests.
  const memberFetchRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeServerId) {
      if (memberFetchRef.current !== activeServerId) {
        memberFetchRef.current = activeServerId;
        fetchMembers(activeServerId);
      }
    } else {
      memberFetchRef.current = null;
      clearMembers();
    }
  }, [activeServerId, fetchMembers, clearMembers]);

  // Presence is handled globally in useWebSocket (presence_snapshot + presence events)

  const handleMemberClick = useCallback((e: React.MouseEvent, member: ServerMember) => {
    setSelectedMember((prev) =>
      prev?.userId === member.user_id
        ? null
        : { userId: member.user_id, position: { x: e.clientX, y: e.clientY } }
    );
  }, []);

  const handleMemberContextMenu = useCallback((e: React.MouseEvent, member: ServerMember) => {
    e.preventDefault();
    setContextMenu({
      member,
      position: { x: e.clientX, y: e.clientY },
    });
  }, []);

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
      const statusOrder: Record<PresenceStatus, number> = {
        online: 0,
        dnd: 1,
        invisible: 2,
        offline: 2,
      };
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

  const renderGroup = (label: string, groupMembers: ServerMember[]) => {
    if (groupMembers.length === 0) return null;
    return (
      <div className="member-group" key={label}>
        <div className="member-group-header">
          <span>
            {label} — {groupMembers.length}
          </span>
        </div>
        {groupMembers.map((member) => (
          <MemberItem
            key={member.user_id}
            member={member}
            status={getMemberStatus(member.user_id)}
            onClick={handleMemberClick}
            onContextMenu={handleMemberContextMenu}
          />
        ))}
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
            onClick={() => activeServerId && fetchMembers(activeServerId)}
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
      {selectedMember && selectedMemberData && (
        <MemberProfileCard
          member={selectedMemberData}
          status={getMemberStatus(selectedMemberData.user_id)}
          lastSeen={lastSeenByUser.get(selectedMemberData.user_id)}
          position={selectedMember.position}
          onClose={() => setSelectedMember(null)}
          onViewFullProfile={() => {
            setFullProfileUserId(selectedMember.userId);
            setSelectedMember(null);
          }}
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
            setFullProfileUserId(contextMenu.member.user_id);
          }}
        />
      )}

      {/* Full Profile Modal */}
      {fullProfileMemberData && (
        <UserProfileModal
          isOpen={!!fullProfileMemberData}
          onClose={() => setFullProfileUserId(null)}
          member={fullProfileMemberData}
          presenceStatus={getMemberStatus(fullProfileMemberData.user_id)}
          lastSeen={lastSeenByUser.get(fullProfileMemberData.user_id)}
        />
      )}
    </div>
  );
};

export default MemberList;
