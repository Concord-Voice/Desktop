import React, { useState, useRef, useEffect } from 'react';
import { Plus, UserPlus } from 'lucide-react';
import { useInviteStore } from '../../stores/inviteStore';
import { ServerWithRole } from '../../types/server';
import './ServerActionBar.css';

interface ServerActionBarProps {
  server: ServerWithRole;
  onOpenCreateModal: () => void;
}

const ServerActionBar: React.FC<ServerActionBarProps> = ({ server, onOpenCreateModal }) => {
  const [showPopup, setShowPopup] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const invites = useInviteStore((state) => state.invites[server.id] || []);
  const fetchInvites = useInviteStore((state) => state.fetchInvites);
  const createInvite = useInviteStore((state) => state.createInvite);

  const canCreateChannel = server.role === 'owner' || server.role === 'admin';
  const canInvite = server.role === 'owner' || server.role === 'admin';
  const buttonCount = (canCreateChannel ? 1 : 0) + (canInvite ? 1 : 0);

  const activeInvite = invites.find((inv) => {
    if (inv.is_revoked) return false;
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return false;
    if (inv.max_uses !== null && inv.use_count >= inv.max_uses) return false;
    return true;
  });

  // Close popup on click outside
  useEffect(() => {
    if (!showPopup) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popupRef.current &&
        !popupRef.current.contains(target) &&
        btnRef.current &&
        !btnRef.current.contains(target)
      ) {
        setShowPopup(false);
        setCopied(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPopup]);

  const handleTogglePopup = async () => {
    if (showPopup) {
      setShowPopup(false);
      setCopied(false);
      return;
    }
    setShowPopup(true);
    setCopied(false);
    if (invites.length === 0) {
      await fetchInvites(server.id);
    }
  };

  const handleCopyCode = async () => {
    if (activeInvite) {
      await navigator.clipboard.writeText(activeInvite.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    const invite = await createInvite(server.id);
    setIsGenerating(false);
    if (invite) {
      await navigator.clipboard.writeText(invite.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // No actions available — just a thin spacer
  if (buttonCount === 0) {
    return <div className="channel-actions-spacer" />;
  }

  return (
    <div className={`channel-actions-strip ${buttonCount === 1 ? 'single' : ''}`}>
      {canCreateChannel && (
        <button
          className="channel-action-item"
          onClick={onOpenCreateModal}
          title="Create a new channel"
        >
          <Plus size={16} />
          <span>Channel</span>
        </button>
      )}

      {canCreateChannel && canInvite && <div className="channel-action-divider" />}

      {canInvite && (
        <button
          ref={btnRef}
          className={`channel-action-item ${showPopup ? 'active' : ''}`}
          onClick={handleTogglePopup}
          title="Invite people to this server"
        >
          <UserPlus size={16} />
          <span>Invite</span>
        </button>
      )}

      {showPopup && (
        <div className="invite-popup" ref={popupRef}>
          <div className="invite-popup-section">
            <div className="invite-popup-header">Invite Code</div>
            {activeInvite ? (
              <>
                <code className="invite-popup-code">{activeInvite.code}</code>
                <button className="invite-popup-action-btn" onClick={handleCopyCode}>
                  {copied ? 'Copied!' : 'Copy Code'}
                </button>
              </>
            ) : (
              <button
                className="invite-popup-action-btn"
                onClick={handleGenerate}
                disabled={isGenerating}
              >
                {isGenerating ? 'Generating...' : 'Generate Code'}
              </button>
            )}
          </div>

          <div className="invite-popup-divider" />

          <div className="invite-popup-section">
            <div className="invite-popup-header">Direct Invite</div>
            <button className="invite-popup-action-btn secondary" disabled>
              <UserPlus size={14} />
              Send to a Friend
            </button>
            <span className="invite-popup-hint">Coming soon — requires DM system</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ServerActionBar;
