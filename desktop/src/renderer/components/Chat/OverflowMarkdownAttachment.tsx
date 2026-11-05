import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, FileText, Loader2 } from 'lucide-react';
import MarkdownContent from '../Markdown/MarkdownContent';
import { apiFetch } from '../../services/system/apiClient';
import { e2eeService } from '../../services/e2ee/e2eeService';
import { formatFileSize } from '../../utils/crypto/attachmentCrypto';
import {
  decryptAttachmentBlob,
  parseKeyVersionHeader,
} from '../../utils/crypto/attachmentChunkedCrypto';
import {
  AttachmentTooLargeError,
  readBoundedBody,
  tooLargeMessage,
} from '../../utils/runtime/boundedResponseBody';
import {
  isRenderableMarkdown,
  MAX_RENDERABLE_MD_BYTES,
} from '../../utils/messaging/renderableMarkdown';
import { MAX_DECRYPTABLE_ATTACHMENT_BYTES } from '../../utils/policy/entitlementLimits';
import type { AttachmentSummary } from '../../types/chat';
import type { MentionLookup } from './messageUtils';
import './OverflowMarkdownAttachment.css';

interface OverflowMarkdownAttachmentProps {
  /** The attachment summary for the overflow .md file. */
  attachment: AttachmentSummary;
  /** Already-decrypted preview body from the parent message — typically ends
   *  with '…'. Shown only until the file itself has loaded. */
  previewBody?: string;
  /** Channel ID used to look up the decryption key. */
  channelId: string;
  /** 'text' shows the file verbatim in a <pre>, so React's escaping is the
   *  only transform it sees; 'markdown' (default) renders it. */
  format?: 'markdown' | 'text';
  /** Download control shown beside a "download to view" fallback. */
  downloadSlot?: React.ReactNode;
}

/** Stable empty lookup so MarkdownContent memoization doesn't bust on every render. */
const EMPTY_MENTION_LOOKUP: MentionLookup = {
  users: new Map(),
  roles: new Map(),
};

/**
 * What a completed load produced. Collapsed/expanded and loading are separate
 * UI flags, because a preloaded file can sit collapsed with its content ready.
 *
 * - rendered: content decoded and safe to show
 * - preview-unavailable: fetch or decrypt failed, or isRenderableMarkdown returned false
 * - too-large: decrypted bytes > MAX_RENDERABLE_MD_BYTES (a RENDER-cost refusal)
 * - too-large-to-open: declared bytes > MAX_DECRYPTABLE_ATTACHMENT_BYTES, refused
 *   before any allocation (a DOWNLOAD refusal — a different limit for a
 *   different cost, so it carries the size that tripped it)
 */
type LoadOutcome =
  | { kind: 'rendered'; content: string }
  | { kind: 'preview-unavailable' }
  | { kind: 'too-large' }
  | { kind: 'too-large-to-open'; bytes: number; truncated?: boolean };

/**
 * Fetch, bound, decrypt and validate the overflow `.md` body, returning the
 * state to apply. Never throws and never touches React, so the effect below
 * stays a thin apply step rather than carrying the whole chain's branching
 * (SonarQube S3776 — the inline version reached cognitive complexity 19).
 *
 * Folding the size refusal into the single catch also widens it: an
 * AttachmentTooLargeError raised anywhere in the chain now reports as
 * `too-large-to-open` rather than only the one raised by readBoundedBody.
 */
async function loadOverflowMarkdown(
  fileId: string,
  channelId: string,
  format: 'markdown' | 'text'
): Promise<LoadOutcome> {
  try {
    const response = await apiFetch(`/api/v1/media/attachments/${fileId}`);
    if (!response.ok) return { kind: 'preview-unavailable' };

    // Measure the body as it arrives rather than trusting either declared size:
    // `file_size` is server-supplied metadata, and Content-Length is absent
    // under chunked transfer encoding and understates a gzipped body.
    const ciphertext = await readBoundedBody(response, MAX_DECRYPTABLE_ATTACHMENT_BYTES);
    // Same epoch selection as AttachmentDisplay: a CSK rotation must not orphan
    // an overflow document that is otherwise perfectly readable.
    const keyVersion = parseKeyVersionHeader(response.headers.get('X-File-Key-Version'));
    const channelKey =
      keyVersion === null
        ? await e2eeService.getChannelKey(channelId)
        : await e2eeService.getChannelKeyByVersion(channelId, keyVersion);
    // Format-aware: handles both the chunked v2 envelope and the legacy
    // single-shot blob, dispatched deterministically before any key is used.
    // The render ceiling is orders of magnitude below the download ceiling, so
    // decrypting past it is work spent on bytes this component is about to
    // discard. Passing the limit stops the loop one chunk after it is exceeded;
    // the Blob is then a PREFIX, which is why the size check below still runs
    // and still rejects.
    const blob = await decryptAttachmentBlob(
      new Uint8Array(ciphertext),
      channelKey,
      format === 'text' ? 'text/plain' : 'text/markdown',
      MAX_RENDERABLE_MD_BYTES
    );

    // Render-cost gate, distinct from the download guard above: cheaper than
    // the full UTF-8 decode plus regex scan that follows.
    //
    // Checked against the Blob BEFORE materialising it, where it used to run
    // after — the gate now precedes the allocation it exists to avoid rather
    // than following it.
    if (blob.size > MAX_RENDERABLE_MD_BYTES) return { kind: 'too-large' };

    const decrypted = new Uint8Array(await blob.arrayBuffer());
    if (!isRenderableMarkdown(decrypted)) return { kind: 'preview-unavailable' };

    return { kind: 'rendered', content: new TextDecoder('utf-8').decode(decrypted) };
  } catch (err) {
    if (err instanceof AttachmentTooLargeError) {
      return { kind: 'too-large-to-open', bytes: err.byteLength, truncated: err.truncated };
    }
    return { kind: 'preview-unavailable' };
  }
}

const OverflowMarkdownAttachment: React.FC<OverflowMarkdownAttachmentProps> = ({
  attachment,
  previewBody = '',
  channelId,
  format = 'markdown',
  downloadSlot,
}) => {
  // Attachment display policy (Mark, 2026-11-05): text and Markdown files
  // PRELOAD into a collapsible space, so the fetch starts when the file scrolls
  // near the viewport rather than on Expand. Expand only opens what is loaded.
  const [outcome, setOutcome] = useState<LoadOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // True only after the user pressed Expand — preloading must not steal focus.
  const [userExpanded, setUserExpanded] = useState(false);
  const startedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Ref for the Collapse button — used to restore keyboard focus after the
  // Expand button disappears and the component transitions to rendered state.
  const collapseRef = useRef<HTMLButtonElement>(null);

  const startLoad = useCallback((): void => {
    if (startedRef.current) return;
    startedRef.current = true;
    // Guards run BEFORE the allocating operation, not between two of them.
    // `file_size` rides on the summary, so an oversized attachment costs no
    // network at all — this is a different limit from MAX_RENDERABLE_MD_BYTES,
    // which is about render cost once the bytes are already resident.
    if (attachment.file_size > MAX_DECRYPTABLE_ATTACHMENT_BYTES) {
      setOutcome({ kind: 'too-large-to-open', bytes: attachment.file_size });
      return;
    }
    setLoading(true);
    void loadOverflowMarkdown(attachment.id, channelId, format).then((result) => {
      // The ref doubles as the unmount guard: cleanup clears it.
      if (!startedRef.current) return;
      setOutcome(result);
      setLoading(false);
    });
  }, [attachment.id, attachment.file_size, channelId, format]);

  // Preload once the file nears the viewport. Without IntersectionObserver
  // (jsdom) the component stays click-to-load, matching MediaAttachment.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        startLoad();
      },
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [startLoad]);

  // An in-flight load must not set state after unmount.
  useEffect(
    () => () => {
      startedRef.current = false;
    },
    []
  );

  const rendered = outcome?.kind === 'rendered' ? outcome.content : null;
  const showFull = expanded && rendered !== null;

  // Move keyboard focus to the Collapse button once the user's Expand lands, so
  // keyboard users are not stranded at <body> after the Expand button vanishes.
  useEffect(() => {
    if (showFull && userExpanded) collapseRef.current?.focus();
  }, [showFull, userExpanded]);

  const handleExpand = useCallback((): void => {
    setExpanded(true);
    setUserExpanded(true);
    startLoad();
  }, [startLoad]);

  const handleCollapse = useCallback((): void => {
    // Return to collapsed without evicting the loaded content.
    setExpanded(false);
    setUserExpanded(false);
  }, []);

  const renderBody = (content: string, id: string): React.ReactNode =>
    format === 'text' ? (
      <pre id={id} className="overflow-md-attachment__text">
        {content}
      </pre>
    ) : (
      <MarkdownContent
        id={id}
        content={content}
        editedAt={null}
        mentionLookup={EMPTY_MENTION_LOOKUP}
      />
    );

  // ------------------------------------------------------------------
  // Fallback states: preview-unavailable, too-large, or too-large-to-open
  // ------------------------------------------------------------------
  if (outcome !== null && outcome.kind !== 'rendered') {
    const typeLabel = format === 'text' ? 'Text file' : 'Markdown file';
    let fallbackMessage: string;
    if (outcome.kind === 'too-large-to-open') {
      // Shared with AttachmentDisplay so the wording cannot drift between the
      // two refusal surfaces (two test files assert it).
      fallbackMessage = tooLargeMessage(outcome.bytes, outcome.truncated, formatFileSize);
    } else if (outcome.kind === 'too-large') {
      fallbackMessage = `${typeLabel} (${formatFileSize(attachment.file_size)}) — too large to preview, download to view.`;
    } else {
      fallbackMessage = 'Preview unavailable — download to view.';
    }

    // The refusal is announced only when the user asked for the content; a
    // preload that hits the refusal is static chip copy like the others.
    const fallbackRole = outcome.kind === 'too-large-to-open' && userExpanded ? 'alert' : undefined;

    return (
      <div className="overflow-md-attachment overflow-md-attachment--fallback" role={fallbackRole}>
        <FileText size={16} aria-hidden="true" />
        {/* AttachmentSummary carries no filename field; "message.md" is the
            conventional display name for overflow markdown attachments. */}
        <span className="overflow-md-attachment__filename">
          {format === 'text' ? 'Text file' : 'message.md'}
        </span>
        <span className="overflow-md-attachment__message">{fallbackMessage}</span>
        {/* "download to view" must name something the reader can press. */}
        {outcome.kind !== 'too-large-to-open' && downloadSlot}
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Expanded: full content + Collapse
  // ------------------------------------------------------------------
  if (showFull) {
    return (
      <div ref={containerRef} className="overflow-md-attachment overflow-md-attachment--rendered">
        {renderBody(rendered, `overflow-full-${attachment.id}`)}
        <button
          ref={collapseRef}
          type="button"
          className="overflow-md-attachment__collapse"
          onClick={handleCollapse}
        >
          <ChevronUp size={16} aria-hidden="true" />
          <span>Collapse</span>
        </button>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Collapsed: the loaded file clipped to a few lines, or the message's own
  // preview body while the load is still pending.
  // ------------------------------------------------------------------
  const stateClass = loading ? 'loading' : 'collapsed';
  return (
    <div
      ref={containerRef}
      className={`overflow-md-attachment overflow-md-attachment--${stateClass}`}
    >
      {rendered !== null ? (
        <div className="overflow-md-attachment__clip">
          {renderBody(rendered, `overflow-preview-${attachment.id}`)}
        </div>
      ) : (
        previewBody !== '' && renderBody(previewBody, `overflow-preview-${attachment.id}`)
      )}
      {loading && expanded ? (
        <output aria-label="Loading full message" className="overflow-md-attachment__spinner">
          <Loader2 size={16} className="spinner" aria-hidden="true" />
          <span>Loading…</span>
        </output>
      ) : (
        <button type="button" className="overflow-md-attachment__expand" onClick={handleExpand}>
          <ChevronDown size={16} aria-hidden="true" />
          <span>Expand ({formatFileSize(attachment.file_size)})</span>
        </button>
      )}
    </div>
  );
};

export default OverflowMarkdownAttachment;
