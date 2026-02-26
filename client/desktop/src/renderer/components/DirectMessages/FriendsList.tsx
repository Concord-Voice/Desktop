import { useState } from 'react';
import { ChevronDown, ChevronRight, UserPlus } from 'lucide-react';
import './DirectMessages.css';

/** Placeholder friend data — will be replaced by friendStore + API */
const MOCK_FRIENDS = [
  { id: 'f1', username: 'alice_chen', displayName: 'Alice Chen', status: 'online' as const },
  { id: 'f2', username: 'bob_smith', displayName: 'Bob Smith', status: 'online' as const },
  { id: 'f3', username: 'jordan_r', displayName: 'Jordan Rivera', status: 'dnd' as const },
  { id: 'f4', username: 'sam_patel', displayName: 'Sam Patel', status: 'offline' as const },
  { id: 'f5', username: 'morgan_lee', displayName: 'Morgan Lee', status: 'offline' as const },
  { id: 'f6', username: 'taylor_w', displayName: 'Taylor Wong', status: 'online' as const },
];

interface FriendsListProps {
  onFriendClick?: (friendId: string) => void;
}

const FriendsList: React.FC<FriendsListProps> = ({ onFriendClick }) => {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

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

  const onlineFriends = MOCK_FRIENDS.filter((f) => f.status !== 'offline');
  const offlineFriends = MOCK_FRIENDS.filter((f) => f.status === 'offline');

  const categories = [
    { id: 'online', label: 'Online', friends: onlineFriends },
    { id: 'offline', label: 'Offline', friends: offlineFriends },
  ];

  return (
    <div className="friends-list">
      <div className="friends-list-header">
        <h3>Friends</h3>
      </div>

      {MOCK_FRIENDS.length === 0 ? (
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
                    onClick={() => onFriendClick?.(friend.id)}
                  >
                    <div className="member-avatar">
                      <span className="member-avatar-initial">
                        {friend.displayName.charAt(0).toUpperCase()}
                      </span>
                      <span className={`member-status-dot ${friend.status}`} />
                    </div>
                    <span className="member-username">{friend.displayName}</span>
                  </div>
                ))}
            </div>
          );
        })
      )}
    </div>
  );
};

export default FriendsList;
