import React, { useState, useEffect, useRef } from 'react';
import Modal from '../ui/Modal';
import LoadingSpinner from '../Auth/LoadingSpinner';
import { useInviteStore } from '../../stores/inviteStore';
import { ServerWithRole } from '../../types/server';
import { ServerInviteWithCreator } from '../../types/server';
import './InviteToServerModal.css';

interface InviteToServerModalProps {
  isOpen: boolean;
  server: ServerWithRole;
  onClose: () => void;
}

const EXPIRY_OPTIONS = [
  { label: '30 minutes', value: 1800 },
  { label: '1 hour', value: 3600 },
  { label: '6 hours', value: 21600 },
  { label: '12 hours', value: 43200 },
  { label: '1 day', value: 86400 },
  { label: '7 days', value: 604800 },
];

const MAX_USES_OPTIONS = [
  { label: 'No limit', value: 0 },
  { label: '1 use', value: 1 },
  { label: '5 uses', value: 5 },
  { label: '10 uses', value: 10 },
  { label: '25 uses', value: 25 },
  { label: '100 uses', value: 100 },
];

const InviteToServerModal: React.FC<InviteToServerModalProps> = ({
  isOpen,
  server,
  onClose,
}) => {
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(86400);
  const [maxUses, setMaxUses] = useState(0);
  const [existingInvites, setExistingInvites] = useState<ServerInviteWithCreator[]>([]);
  const codeRef = useRef<HTMLInputElement>(null);

  const createInvite = useInviteStore((state) => state.createInvite);
  const fetchInvites = useInviteStore((state) => state.fetchInvites);
  const invites = useInviteStore((state) => state.invites[server.id] || []);

  // Load existing invites when modal opens
  useEffect(() => {
    if (isOpen) {
      fetchInvites(server.id);
      setGeneratedCode(null);
      setCopied(false);
      setError(null);
      setExpiresIn(86400);
      setMaxUses(0);
    }
  }, [isOpen, server.id, fetchInvites]);

  // Filter active invites
  useEffect(() => {
    const active = invites.filter((inv) => {
      if (inv.is_revoked) return false;
      if (inv.expires_at && new Date(inv.expires_at) < new Date()) return false;
      if (inv.max_uses !== null && inv.max_uses > 0 && inv.use_count >= inv.max_uses) return false;
      return true;
    });
    setExistingInvites(active);
  }, [invites]);

  const handleGenerateCode = async () => {
    setIsGenerating(true);
    setError(null);
    setCopied(false);

    try {
      const opts: { max_uses?: number; expires_in?: number } = {
        expires_in: expiresIn,
      };
      if (maxUses > 0) {
        opts.max_uses = maxUses;
      }

      const invite = await createInvite(server.id, opts);
      if (invite) {
        setGeneratedCode(invite.code);
        // Auto-copy to clipboard
        await navigator.clipboard.writeText(invite.code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        setError('Failed to create invite');
      }
    } catch (err) {
      setError('Failed to create invite');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyCode = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSelectCode = () => {
    codeRef.current?.select();
  };

  const formatExpiry = (expiresAt: string | null) => {
    if (!expiresAt) return 'Never';
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    if (hours >= 24) return `${Math.floor(hours / 24)}d remaining`;
    if (hours > 0) return `${hours}h remaining`;
    return `${minutes}m remaining`;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Invite to Server" width="medium">
      <div className="invite-modal">
        {/* Server header */}
        <div className="invite-modal-server">
          <div className="invite-modal-server-icon">
            {server.icon ? (
              <img src={server.icon} alt={server.name} />
            ) : (
              <span>{server.name.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <span className="invite-modal-server-name">{server.name}</span>
        </div>

        {/* Generate new invite */}
        <div className="invite-modal-section">
          <h4 className="invite-modal-section-title">Generate Invite Code</h4>
          <p className="invite-modal-section-desc">
            Create a code that others can use to join this server.
          </p>

          <div className="invite-modal-options">
            <div className="invite-option-group">
              <label className="invite-option-label">Expires after</label>
              <select
                className="invite-option-select"
                value={expiresIn}
                onChange={(e) => setExpiresIn(Number(e.target.value))}
                disabled={isGenerating}
              >
                {EXPIRY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            <div className="invite-option-group">
              <label className="invite-option-label">Max uses</label>
              <select
                className="invite-option-select"
                value={maxUses}
                onChange={(e) => setMaxUses(Number(e.target.value))}
                disabled={isGenerating}
              >
                {MAX_USES_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Generated code display */}
          {generatedCode && (
            <div className="invite-code-display">
              <input
                ref={codeRef}
                className="invite-code-value"
                value={generatedCode}
                readOnly
                onClick={handleSelectCode}
              />
              <button
                className="invite-code-copy-btn"
                onClick={() => handleCopyCode(generatedCode)}
              >
                {copied ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M2 8.5l3.5 3.5L14 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                )}
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          )}

          {error && (
            <div className="form-error-banner">
              <span>{error}</span>
            </div>
          )}

          <button
            className="invite-generate-btn"
            onClick={handleGenerateCode}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <>
                Generating...
                <LoadingSpinner size="small" inline />
              </>
            ) : generatedCode ? (
              'Generate New Code'
            ) : (
              'Generate Invite Code'
            )}
          </button>
        </div>

        {/* Existing active invites */}
        {existingInvites.length > 0 && (
          <div className="invite-modal-section">
            <h4 className="invite-modal-section-title">Active Invites</h4>
            <div className="invite-existing-list">
              {existingInvites.map((inv) => (
                <div key={inv.id} className="invite-existing-item">
                  <div className="invite-existing-info">
                    <span className="invite-existing-code">{inv.code}</span>
                    <span className="invite-existing-meta">
                      {inv.use_count} use{inv.use_count !== 1 ? 's' : ''}
                      {inv.max_uses !== null && inv.max_uses > 0 ? ` / ${inv.max_uses}` : ''}
                      {' · '}
                      {formatExpiry(inv.expires_at)}
                    </span>
                  </div>
                  <button
                    className="invite-existing-copy"
                    onClick={() => handleCopyCode(inv.code)}
                    title="Copy code"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default InviteToServerModal;
