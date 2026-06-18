import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, LockOpen } from 'lucide-react';
import { ServerWithRole } from '../../types/server';

/**
 * Computes the on-screen position for the E2EE tooltip relative to its trigger,
 * preferring right-edge alignment and clamping to the viewport. Moved here with
 * the indicator (from MainView) so MainView's cognitive complexity stays below
 * the SonarCloud rule threshold (SC-1).
 */
const computeE2eeTooltipPos = (rect: DOMRect): { top: number; left: number } => {
  const tooltipWidth = 240;
  const padding = 8;
  const top = rect.bottom + padding;

  const leftAligned = rect.right - tooltipWidth;
  if (leftAligned >= padding) {
    return { top, left: leftAligned };
  }
  const maxLeft = globalThis.innerWidth - tooltipWidth - padding;
  return { top, left: Math.min(rect.left, maxLeft) };
};

interface ServerE2eeIndicatorProps {
  server: ServerWithRole;
}

/**
 * The server-level E2EE lock shown in the channel-panel header, plus its hover
 * tooltip (portaled to <body> to escape transform-based containing blocks).
 * Extracted from MainView (SC-1) so the E2EE state / ref / callbacks / portal no
 * longer inflate MainView's cognitive complexity. Behavior is unchanged: the
 * tooltip still portals to document.body, so co-locating it with its trigger
 * does not move it in the DOM.
 */
const ServerE2eeIndicator: React.FC<ServerE2eeIndicatorProps> = ({ server }) => {
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const indicatorRef = useRef<HTMLButtonElement>(null);

  const showTooltip = useCallback(() => {
    if (indicatorRef.current) {
      setTooltipPos(computeE2eeTooltipPos(indicatorRef.current.getBoundingClientRect()));
    }
  }, []);
  const hideTooltip = useCallback(() => setTooltipPos(null), []);

  return (
    <>
      <button
        type="button"
        ref={indicatorRef}
        className={`server-e2ee-indicator ${server.e2ee_default ? 'encrypted' : 'unencrypted'}`}
        aria-label={
          server.e2ee_default
            ? 'Server end-to-end encryption: enabled by default'
            : 'Server end-to-end encryption: not enabled by default'
        }
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
      >
        {server.e2ee_default ? <Lock size={12} /> : <LockOpen size={12} />}
      </button>
      {tooltipPos &&
        createPortal(
          <div
            className={`e2ee-tooltip visible ${server.e2ee_default ? 'encrypted' : 'unencrypted'}`}
            style={{ top: tooltipPos.top, left: tooltipPos.left }}
          >
            <span className="e2ee-tooltip-header">
              {server.e2ee_default ? <Lock size={11} /> : <LockOpen size={11} />}
              {server.e2ee_default ? 'E2EE Enabled' : 'E2EE Disabled'}
            </span>
            <span className="e2ee-tooltip-body">
              {server.e2ee_default
                ? 'End-to-End Encryption is enabled by default in this server. New channels are created with E2EE on.'
                : 'End-to-End Encryption is not enabled by default in this server. Channels may still enable E2EE individually.'}
            </span>
            <span className="e2ee-tooltip-hint">
              Always check the channel encryption status near the message box to verify E2EE.
            </span>
          </div>,
          document.body
        )}
    </>
  );
};

export default ServerE2eeIndicator;
