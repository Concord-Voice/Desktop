import { useState } from 'react';
import { MessageSquare, PhoneMissed, Users } from 'lucide-react';
import './DirectMessages.css';

/** Placeholder conversation data — will be replaced by dmStore + API */
const MOCK_CONVERSATIONS = [
  {
    id: 'conv-1',
    name: 'Alice Chen',
    isGroup: false,
    status: 'online' as const,
    lastMessage: 'Hey, are you free for a call later?',
    timestamp: '2m ago',
    unread: 3,
    missedCall: false,
  },
  {
    id: 'conv-2',
    name: 'Project Alpha',
    isGroup: true,
    status: 'online' as const,
    lastMessage: 'Bob: Pushed the fix to staging',
    timestamp: '15m ago',
    unread: 0,
    missedCall: false,
  },
  {
    id: 'conv-3',
    name: 'Jordan Rivera',
    isGroup: false,
    status: 'dnd' as const,
    lastMessage: 'Missed voice call',
    timestamp: '1h ago',
    unread: 1,
    missedCall: true,
  },
  {
    id: 'conv-4',
    name: 'Sam Patel',
    isGroup: false,
    status: 'offline' as const,
    lastMessage: 'Thanks for the help!',
    timestamp: 'Yesterday',
    unread: 0,
    missedCall: false,
  },
];

interface ConversationListProps {
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
}

const ConversationList: React.FC<ConversationListProps> = ({
  selectedThreadId,
  onSelectThread,
}) => {
  const [search, setSearch] = useState('');

  const filtered = MOCK_CONVERSATIONS.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="conversation-list">
      <div className="conversation-search">
        <input
          type="text"
          placeholder="Search conversations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="conversation-list-empty">
          <MessageSquare size={32} />
          <p>No conversations yet</p>
        </div>
      ) : (
        filtered.map((conv) => (
          <div
            key={conv.id}
            className={`conversation-item${selectedThreadId === conv.id ? ' active' : ''}${conv.unread > 0 ? ' unread' : ''}`}
            onClick={() => onSelectThread(conv.id)}
          >
            <div className={`conversation-avatar${conv.isGroup ? ' group' : ''}`}>
              {conv.isGroup ? (
                <Users size={18} />
              ) : (
                <span className="conversation-avatar-initial">
                  {conv.name.charAt(0).toUpperCase()}
                </span>
              )}
              {!conv.isGroup && (
                <span className={`member-status-dot ${conv.status}`} />
              )}
            </div>

            <div className="conversation-content">
              <div className="conversation-top-row">
                <span className="conversation-name">{conv.name}</span>
                <span className="conversation-time">{conv.timestamp}</span>
              </div>
              <div className="conversation-bottom-row">
                <span className="conversation-preview">{conv.lastMessage}</span>
                <div className="conversation-badges">
                  {conv.missedCall && (
                    <span className="conversation-missed-call">
                      <PhoneMissed size={14} />
                    </span>
                  )}
                  {conv.unread > 0 && (
                    <span className="conversation-unread-badge">
                      {conv.unread > 99 ? '99+' : conv.unread}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
};

export default ConversationList;
