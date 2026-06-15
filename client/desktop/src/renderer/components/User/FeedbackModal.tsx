import React, { useCallback, useState } from 'react';
import Modal from '../ui/Modal';
import { apiFetch, safeJson } from '../../services/apiClient';
import { type SystemInfo } from '../../services/systemInfoService';
import './FeedbackModal.css';

/**
 * Feedback modal entry point (#158).
 *
 * Hosts the mode switcher (Bug Report / Feature Request) and the shared
 * submit pipe to `POST /api/v1/feedback`. The bug-mode and feature-mode
 * panel bodies are intentionally placeholder content on this branch — they
 * are filled in by the follow-up branches that close #159 and #160. The
 * shell, switching, submit wiring, log buffer integration, and system-info
 * collection all live here on the infra branch so the panels only need to
 * own their form fields.
 */

export type FeedbackMode = 'bug' | 'feature';

export interface FeedbackSubmission {
  type: FeedbackMode;
  title: string;
  description: string;
  /** Feature-only; one of 'feature' | 'improvement' | 'ux' | 'performance' | 'other'. */
  category?: string;
  /** Bug-only; populated when the user checks "Include diagnostic logs". */
  diagnostics?: {
    appVersion: string;
    platform: string;
    machineIdPrefix: string;
    gpu?: SystemInfo['gpu'];
    display?: SystemInfo['display'];
    connectionPhase: string;
    logs: string;
  };
}

interface FeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Optional initial mode. Defaults to 'bug'. */
  initialMode?: FeedbackMode;
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; issueUrl?: string; dev: boolean }
  | { status: 'error'; message: string };

const DEV_TEST_DESCRIPTION =
  'Placeholder submission from the dev-only debug button on the infra branch. Replace with real form fields in #159 / #160.';

/**
 * Inner component for the success-state issue URL. Extracted so the URL is
 * captured into a local const at the consumer's site (where TS narrowing
 * works), avoiding the non-null assertion lint pushback at the closure call
 * site.
 */
const SubmitSuccessLink: React.FC<{ url: string }> = ({ url }) => (
  <p>
    Tracked at:{' '}
    <a
      href={url}
      onClick={(e) => {
        e.preventDefault();
        void globalThis.electron?.openExternal?.(url);
      }}
    >
      {url}
    </a>
  </p>
);

const FeedbackModal: React.FC<FeedbackModalProps> = ({ isOpen, onClose, initialMode = 'bug' }) => {
  const [mode, setMode] = useState<FeedbackMode>(initialMode);
  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle' });

  /**
   * Shared submit handler. The panels (in #159 / #160) call this with their
   * assembled `FeedbackSubmission`. Centralizing the network call here means
   * the panels never see a fetch primitive — they only describe what they
   * want to send.
   */
  const submit = useCallback(async (payload: FeedbackSubmission) => {
    setSubmitState({ status: 'submitting' });
    try {
      const res = await apiFetch('/api/v1/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.status === 429) {
        setSubmitState({
          status: 'error',
          message: 'Rate limit reached. Please wait an hour before submitting again.',
        });
        return;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        setSubmitState({
          status: 'error',
          message: `Submission failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`,
        });
        return;
      }
      const json = await safeJson<{ issueUrl?: string; dev?: boolean }>(res);
      setSubmitState({
        status: 'success',
        issueUrl: json.issueUrl,
        dev: json.dev === true,
      });
    } catch (err) {
      setSubmitState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Network error while submitting feedback.',
      });
    }
  }, []);

  /**
   * Reset and close. Called from the modal's close button and after the user
   * acknowledges a success/error message.
   */
  const handleClose = useCallback(() => {
    setSubmitState({ status: 'idle' });
    onClose();
  }, [onClose]);

  /**
   * Dev-only smoke trigger handler. Extracted from the JSX onClick so the
   * arrow-with-multiline-object pattern doesn't trip cognitive-complexity
   * rules on the inline JSX attribute (Sonar). Removed when #159 / #160
   * wire real submission.
   */
  const handleDevTestSubmit = useCallback(() => {
    void submit({
      type: mode,
      title: 'Infrastructure smoke test',
      description: DEV_TEST_DESCRIPTION,
    });
  }, [mode, submit]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Send Feedback" width="xlarge">
      <div className="feedback-modal">
        {/* Mode switcher */}
        <div className="feedback-mode-switch" role="tablist" aria-label="Feedback type">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'bug'}
            className={`feedback-mode-tab ${mode === 'bug' ? 'active' : ''}`}
            onClick={() => setMode('bug')}
          >
            Bug Report
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'feature'}
            className={`feedback-mode-tab ${mode === 'feature' ? 'active' : ''}`}
            onClick={() => setMode('feature')}
          >
            Feature Request
          </button>
        </div>

        {/* Panel body — placeholder until #159 / #160 land */}
        <div className="feedback-panel-body" role="tabpanel">
          {mode === 'bug' && (
            <p className="feedback-panel-placeholder">
              Bug report form coming soon. Track progress in <code>#159</code>.
            </p>
          )}
          {mode === 'feature' && (
            <p className="feedback-panel-placeholder">
              Feature request form coming soon. Track progress in <code>#160</code>.
            </p>
          )}

          {/* Dev-only smoke trigger so the submit pipe is exercised on this
              infra branch before the panels arrive. Hidden in production
              builds. Removed once #159 / #160 wire real submission. */}
          {import.meta.env.DEV && submitState.status === 'idle' && (
            <button type="button" className="feedback-btn-secondary" onClick={handleDevTestSubmit}>
              Send Test Submission (dev)
            </button>
          )}

          {/* Submit-state surface — visible across both panels */}
          {submitState.status === 'submitting' && (
            <p className="feedback-submit-status">Submitting…</p>
          )}
          {submitState.status === 'success' && (
            <div className="feedback-submit-success">
              <p>
                Thank you for the feedback!
                {submitState.dev && ' (Stubbed in dev — no GitHub issue created.)'}
              </p>
              {submitState.issueUrl && <SubmitSuccessLink url={submitState.issueUrl} />}
            </div>
          )}
          {submitState.status === 'error' && (
            <p className="feedback-submit-error" role="alert">
              {submitState.message}
            </p>
          )}
        </div>

        {/* Footer — close + submit (submit visible to keep the contract
            obvious for the panel branches; they'll wire their assembled
            payload into the existing `submit` handler exported below.) */}
        <div className="feedback-modal-footer">
          <button type="button" className="feedback-btn-secondary" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default FeedbackModal;
// Exported for the panel branches (#159 / #160). They import this from the
// same module path the modal does.
export { FeedbackModal };
