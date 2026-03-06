import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, UserPlus, Plus, Check, X, Clock, MessageSquare, UserMinus } from 'lucide-react';
import { useFriendStore } from '../../stores/friendStore';
import type { Friend } from '../../stores/friendStore';
import ContextMenu from '../ui/ContextMenu';
import AddFriendModal from './AddFriendModal';
import './DirectMessages.css';

interface FriendsListProps {
  onFriendClick?: (userId: string) => void;
}

const FriendsList: React.FC<FriendsListProps> = ({ onFriendClick }) => {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [showAddFriendModal, setShowAddFriendModal] = useState(false);
  const friends = useFriendStore((s) => s.friends);
  const fetchFriends = useFriendStore((s) => s.fetchFriends);
  const pendingRequests = useFriendStore((s) => s.pendingRequests);
  const fetchRequests = useFriendStore((s) => s.fetchRequests);
  const acceptRequest = useFriendStore((s) => s.acceptRequest);
  const declineRequest = useFriendStore((s) => s.declineRequest);
  const removeFriend = useFriendStore((s) => s.removeFriend);
  const [actionLoading, setActionLoading] = useState<Record<string, 'accept' | 'decline' | null>>({});
  const [contextMenu, setContextMenu] = useState<{
    friend: Friend;
    position: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    fetchFriends();
    fetchRequests();
  }, [fetchFriends, fetchRequests]);

  const toggleCategory = (category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const handleAccept = useCallback(async (requestId: string) => {
    setActionLoading((prev) => ({ ...prev, [requestId]: 'accept' }));
    try {
      await acceptRequest(requestId);
    } catch (err) {
      console.error('Failed to accept friend request:', err);
    } finally {
      setActionLoading((prev) => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
    }
  }, [acceptRequest]);

  const handleDecline = useCallback(async (requestId: string) => {
    setActionLoading((prev) => ({ ...prev, [requestId]: 'decline' }));
    try {
      await declineRequest(requestId);
    } catch (err) {
      console.error('Failed to decline friend request:', err);
    } finally {
      setActionLoading((prev) => {
        const next = { ...prev };
        delete next[requestId];
        return next;
      });
    }
  }, [declineRequest]);

  const handleFriendContextMenu = useCallback((e: React.MouseEvent, friend: Friend) => {
    e.preventDefault();
    setContextMenu({ friend, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const handleRemoveFriend = useCallback(async (userId: string) => {
    setContextMenu(null);
    try {
      await removeFriend(userId);
    } catch (err) {
      console.error('Failed to remove friend:', err);
    }
  }, [removeFriend]);

  const incomingRequests = pendingRequests.filter((r) => r.direction === 'received');
  const outgoingRequests = pendingRequests.filter((r) => r.direction === 'sent');
  const incomingCount = incomingRequests.length;

  const onlineFriends = friends.filter((f) => f.status !== 'offline');
  const offlineFriends = friends.filter((f) => f.status === 'offline');

  const categories = [
    { id: 'online', label: 'Online', friends: onlineFriends },
    { id: 'offline', label: 'Offline', friends: offlineFriends },
  ];

  return (
    <div className="friends-list">
      <div className="friends-list-header">
        <h3>
          Friends
          {incomingCount > 0 && (
            <span className="conversation-unread-badge friends-header-badge">
              {incomingCount}
            </span>
          )}
        </h3>
        <button
          className="friends-add-btn"
          onClick={() => setShowAddFriendModal(true)}
          title="Add Friend"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Pending Requests Section */}
      {pendingRequests.length > 0 && (
        <div className="friend-category">
          <div
            className="friend-category-header"
            onClick={() => toggleCategory('pending')}
          >
            {collapsedCategories.has('pending') ? (
              <ChevronRight size={12} />
            ) : (
              <ChevronDown size={12} />
            )}
            <span>Pending Requests</span>
            <span className="friend-category-count">{pendingRequests.length}</span>
          </div>

          {!collapsedCategories.has('pending') && (
            <>
              {/* Incoming requests */}
              {incomingRequests.map((req) => {
                const displayName = req.fromDisplayName || req.fromUsername;
                const initial = displayName.charAt(0).toUpperCase();
                const isLoading = actionLoading[req.id];
                return (
                  <div key={req.id} className="friend-item friend-request-item">
                    <div className="member-avatar">
                      <span className="member-avatar-initial">{initial}</span>
                    </div>
                    <div className="friend-request-info">
                      <span className="member-username">{displayName}</span>
                      <span className="friend-request-meta">Incoming request</span>
                    </div>
                    <div className="friend-request-actions">
                      <button
                        className="friend-request-btn friend-request-accept"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAccept(req.id);
                        }}
                        disabled={!!isLoading}
                        title="Accept"
                      >
                        {isLoading === 'accept' ? (
                          <span className="friend-request-spinner" />
                        ) : (
                          <Check size={14} />
                        )}
                      </button>
                      <button
                        className="friend-request-btn friend-request-decline"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDecline(req.id);
                        }}
                        disabled={!!isLoading}
                        title="Decline"
                      >
                        {isLoading === 'decline' ? (
                          <span className="friend-request-spinner" />
                        ) : (
                          <X size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Outgoing requests */}
              {outgoingRequests.map((req) => {
                const displayName = req.toDisplayName || req.toUsername;
                const initial = displayName.charAt(0).toUpperCase();
                return (
                  <div key={req.id} className="friend-item friend-request-item friend-request-outgoing">
                    <div className="member-avatar">
                      <span className="member-avatar-initial">{initial}</span>
                    </div>
                    <div className="friend-request-info">
                      <span className="member-username">{displayName}</span>
                      <span className="friend-request-meta">Outgoing request</span>
                    </div>
                    <div className="friend-request-actions">
                      <span className="friend-request-pending-label">
                        <Clock size={12} />
                        Pending
                      </span>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {friends.length === 0 ? (
        <div className="friends-list-empty">
          <UserPlus size={28} style={{ marginBottom: 8, opacity: 0.4 }} />
          <p>Add friends to see them here</p>
        </div>
      ) : (
        categories.map((cat) => {
          const isCollapsed = collapsedCategories.has(cat.id);
          return (
            <div key={cat.id} className="friend-category">
              <div className="friend-category-header" onClick={() => toggleCategory(cat.id)}>
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span>{cat.label}</span>
                <span className="friend-category-count">{cat.friends.length}</span>
              </div>

              {!isCollapsed &&
                cat.friends.map((friend) => (
                  <div
                    key={friend.id}
                    className={`friend-item ${friend.status === 'offline' ? 'offline' : ''}`}
                    onClick={() => onFriendClick?.(friend.userId)}
                    onContextMenu={(e) => handleFriendContextMenu(e, friend)}
                  >
                    <div className="member-avatar">
                      <span className="member-avatar-initial">
                        {(friend.displayName || friend.username).charAt(0).toUpperCase()}
                      </span>
                      <span className={`member-status-dot ${friend.status}`} />
                    </div>
                    <span className="member-username">{friend.displayName || friend.username}</span>
                  </div>
                ))}
            </div>
          );
        })
      )}

      {contextMenu && (
        <ContextMenu
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        >
          <ContextMenu.Header>
            {contextMenu.friend.displayName || contextMenu.friend.username}
          </ContextMenu.Header>
          <ContextMenu.Separator />
          <ContextMenu.Item
            icon={<MessageSquare size={14} />}
            label="Message"
            onClick={() => {
              onFriendClick?.(contextMenu.friend.userId);
              setContextMenu(null);
            }}
          />
          <ContextMenu.Separator />
          <ContextMenu.Item
            icon={<UserMinus size={14} />}
            label="Remove Friend"
            danger
            onClick={() => handleRemoveFriend(contextMenu.friend.userId)}
          />
        </ContextMenu>
      )}

      <AddFriendModal isOpen={showAddFriendModal} onClose={() => setShowAddFriendModal(false)} />
    </div>
  );
};

export default FriendsList;
