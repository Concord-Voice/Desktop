import React, { useState, useRef, useEffect } from 'react';
import { useInviteStore } from '../../stores/inviteStore';
import { ServerWithRole } from '../../types/server';
import './ServerActionBar.css';

interface ServerActionBarProps {
  server: ServerWithRole;
}

const ServerActionBar: React.FC<ServerActionBarProps> = ({ server }) => {
  const [showInvitePopup, setShowInvitePopup] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  const invites = useInviteStore((state) => state.invites[server.id] || []);
  const fetchInvites = useInviteStore((state) => state.fetchInvites);
  const createInvite = useInviteStore((state) => state.createInvite);

  const canInvite = server.role === 'owner' || server.role === 'admin';

  const activeInvite = invites.find((inv) => {
    if (inv.is_revoked) return false;
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) return false;
    if (inv.max_uses !== null && inv.use_count >= inv.max_uses) return false;
    return true;
  });

  // Close popup on click outside
  useEffect(() => {
    if (!showInvitePopup) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setShowInvitePopup(false);
        setCopied(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showInvitePopup]);

  const handleInviteClick = async () => {
    if (showInvitePopup) {
      setShowInvitePopup(false);
      setCopied(false);
      return;
    }
    setShowInvitePopup(true);
    setCopied(false);
    // Fetch invites if we don't have any
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

  if (!canInvite) return null;

  return (
    <div className="server-action-bar">
      <div className="server-action-bar-buttons">
        <button
          className={`server-action-btn ${showInvitePopup ? 'active' : ''}`}
          onClick={handleInviteClick}
          title="Invite"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 1v14M1 8h14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <span className="server-action-btn-label">Invite</span>
        </button>

        {/* Placeholder for Direct Invite — to be implemented with DM system (Issue #81) */}
        <button
          className="server-action-btn"
          disabled
          title="Direct Invite (coming soon — requires DM system)"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M11 5a3 3 0 11-6 0 3 3 0 016 0zM2 13.5c0-2.5 2.5-4 6-4s6 1.5 6 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="server-action-btn-label">Direct</span>
        </button>
      </div>

      {showInvitePopup && (
        <div className="invite-popup" ref={popupRef}>
          <div className="invite-popup-header">Invite Code</div>
          {activeInvite ? (
            <>
              <code className="invite-popup-code">{activeInvite.code}</code>
              <button className="invite-popup-copy-btn" onClick={handleCopyCode}>
                {copied ? 'Copied!' : 'Copy Code'}
              </button>
            </>
          ) : (
            <button
              className="invite-popup-copy-btn"
              onClick={handleGenerate}
              disabled={isGenerating}
            >
              {isGenerating ? 'Generating...' : 'Generate Code'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ServerActionBar;
