import { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, UserPlus, Plus } from 'lucide-react';
import { useFriendStore } from '../../stores/friendStore';
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

  useEffect(() => {
    fetchFriends();
  }, [fetchFriends]);

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

  const onlineFriends = friends.filter((f) => f.status !== 'offline');
  const offlineFriends = friends.filter((f) => f.status === 'offline');

  const categories = [
    { id: 'online', label: 'Online', friends: onlineFriends },
    { id: 'offline', label: 'Offline', friends: offlineFriends },
  ];

  return (
    <div className="friends-list">
      <div className="friends-list-header">
        <h3>Friends</h3>
        <button className="friends-add-btn" onClick={() => setShowAddFriendModal(true)} title="Add Friend">
          <Plus size={16} />
        </button>
      </div>

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
              <div
                className="friend-category-header"
                onClick={() => toggleCategory(cat.id)}
              >
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

      <AddFriendModal isOpen={showAddFriendModal} onClose={() => setShowAddFriendModal(false)} />
    </div>
  );
};

export default FriendsList;
