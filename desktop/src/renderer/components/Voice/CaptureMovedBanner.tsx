import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Info } from 'lucide-react';
import { useVoiceStore } from '../../stores/voice/voiceStore';
import { CAPTURE_LEASE_COPY } from '../../services/voice/captureLeaseClient';
import './CaptureMovedBanner.css';

/** Focusable in Tab order: native controls that are not disabled, and positive tabindex. */
const TABBABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

// T0 row 7 (`BANNER_VISIBILITY_SIGNAL = 'visibilityState'`): a backgrounded connection's
// document reports `hidden` and receives `visibilitychange`, so text written while hidden
// would be announced into a document nobody is reading.
function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible';
}

/**
 * The first tabbable element after the banner in DOM order. With none, the `.app` root,
 * made programmatically focusable; never `<body>`, where keyboard users lose their place.
 */
function focusTargetAfter(banner: HTMLElement): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(TABBABLE)) {
    if (banner.contains(el) || el.closest('[inert], [hidden]')) continue;
    if (banner.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) return el;
  }
  const app = banner.closest<HTMLElement>('.app');
  app?.setAttribute('tabindex', '-1');
  return app;
}

/** Mounted only while the notice is set, so each notice starts with empty text. */
const CaptureMovedBannerBody: React.FC = () => {
  const visible = useSyncExternalStore(subscribeVisibility, isDocumentVisible);
  const [shown, setShown] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // #3394 pattern: the region is in the tree empty, and the text arrives one frame after
  // the document is visible. Latched, so hiding the document again does not clear it.
  // A `cancelled` flag rather than cancelAnimationFrame, which jsdom does not implement.
  useEffect(() => {
    if (!visible || shown) return undefined;
    let cancelled = false;
    requestAnimationFrame(() => {
      if (!cancelled) setShown(true);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, shown]);

  const handleDismiss = () => {
    // Captured before the banner unmounts, so DOM order is still the banner's own.
    const banner = rootRef.current;
    const target = banner ? focusTargetAfter(banner) : null;
    target?.focus();
    useVoiceStore.getState().setCaptureMovedNotice(false);
  };

  return (
    <div ref={rootRef} className="capture-moved-banner" role="status">
      <span className="capture-moved-banner__message">
        <Info size={16} aria-hidden="true" className="capture-moved-banner__glyph" />
        <span className="capture-moved-banner__text">{shown ? CAPTURE_LEASE_COPY.banner : ''}</span>
      </span>
      <button type="button" className="capture-moved-banner__dismiss" onClick={handleDismiss}>
        {CAPTURE_LEASE_COPY.dismiss}
      </button>
    </div>
  );
};

/**
 * Shown after a `moved` revocation ended this connection's call (#87 §3.8). App mounts it
 * directly after UpdateBanner, outside the PiP window. No timer: it stays until dismissed,
 * a granted join clears it, or the account changes.
 */
const CaptureMovedBanner: React.FC = () => {
  const notice = useVoiceStore((s) => s.captureMovedNotice);
  return notice ? <CaptureMovedBannerBody /> : null;
};

export default CaptureMovedBanner;
