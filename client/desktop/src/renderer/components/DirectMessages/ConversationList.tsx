import { useState, useEffect } from 'react';
import { MessageSquare, Users, BookOpen } from 'lucide-react';
import { useDMStore, type DMConversation } from '../../stores/dmStore';
import { useUserStore } from '../../stores/userStore';
import './DirectMessages.css';

interface ConversationListProps {
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
}

/** Get display name for a conversation (other user's name for 1:1, group name for group) */
function getConversationName(conv: DMConversation, currentUserId: string): string {
  if (conv.isGroup) {
    return conv.name || conv.participants.map((p) => p.displayName || p.username).join(', ');
  }
  // 1:1 — show the other participant's name
  const other = conv.participants.find((p) => p.userId !== currentUserId);
  return other?.displayName || other?.username || 'Unknown';
}

/** Get the initial letter for the avatar */
function getInitial(conv: DMConversation, currentUserId: string): string {
  return getConversationName(conv, currentUserId).charAt(0).toUpperCase();
}

/** Get relative timestamp string */
function getRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;

  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

const ConversationList: React.FC<ConversationListProps> = ({
  selectedThreadId,
  onSelectThread,
}) => {
  const [search, setSearch] = useState('');
  const conversations = useDMStore((s) => s.conversations);
  const fetchConversations = useDMStore((s) => s.fetchConversations);
  const openPersonalThread = useDMStore((s) => s.openPersonalThread);
  const currentUserId = useUserStore((s) => s.user?.id) || '';

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Separate personal thread from regular conversations
  const personalThread = conversations.find((c) => c.isPersonal);

  const filtered = conversations
    .filter((c) => !c.isPersonal)
    .filter((c) => {
      const name = getConversationName(c, currentUserId);
      return name.toLowerCase().includes(search.toLowerCase());
    });

  const handleOpenPersonalThread = async () => {
    try {
      const conv = await openPersonalThread();
      onSelectThread(conv.id);
    } catch (err) {
      console.error('Failed to open personal thread:', err);
    }
  };

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

      {/* Pinned Personal Thread */}
      <div
        className={`conversation-item personal-thread${
          personalThread && selectedThreadId === personalThread.id ? ' active' : ''
        }`}
        onClick={handleOpenPersonalThread}
      >
        <div className="conversation-avatar personal-thread-avatar">
          <BookOpen size={14} />
        </div>
        <span className="conversation-name personal-thread-name">Personal Thread</span>
      </div>
      <div className="personal-thread-divider" />

      {filtered.length === 0 ? (
        <div className="conversation-list-empty">
          <MessageSquare size={32} />
          <p>No conversations yet</p>
        </div>
      ) : (
        filtered.map((conv) => {
          const name = getConversationName(conv, currentUserId);
          const other = conv.isGroup ? null : conv.participants.find((p) => p.userId !== currentUserId);
          const status = other?.status || 'offline';
          const lastTime = conv.lastMessage?.createdAt || conv.createdAt;
          const preview = conv.lastMessage
            ? conv.lastMessage.isEncrypted && !conv.lastMessage.content
              ? '[Encrypted message]'
              : conv.lastMessage.content
            : '';

          return (
            <div
              key={conv.id}
              className={`conversation-item${selectedThreadId === conv.id ? ' active' : ''}${conv.unreadCount > 0 ? ' unread' : ''}`}
              onClick={() => onSelectThread(conv.id)}
            >
              <div className={`conversation-avatar${conv.isGroup ? ' group' : ''}`}>
                {conv.isGroup ? (
                  <Users size={18} />
                ) : (
                  <span className="conversation-avatar-initial">
                    {getInitial(conv, currentUserId)}
                  </span>
                )}
                {!conv.isGroup && (
                  <span className={`member-status-dot ${status}`} />
                )}
              </div>

              <div className="conversation-content">
                <div className="conversation-top-row">
                  <span className="conversation-name">{name}</span>
                  <span className="conversation-time">{getRelativeTime(lastTime)}</span>
                </div>
                <div className="conversation-bottom-row">
                  <span className="conversation-preview">{preview}</span>
                  <div className="conversation-badges">
                    {conv.unreadCount > 0 && (
                      <span className="conversation-unread-badge">
                        {conv.unreadCount > 99 ? '99+' : conv.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};

export default ConversationList;
