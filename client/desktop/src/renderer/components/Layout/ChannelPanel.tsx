import React, { useRef, useCallback, useEffect, useState } from 'react';
import { Pin, PinOff } from 'lucide-react';
import { useLayoutStore } from '../../stores/layoutStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import UserPanel from '../User/UserPanel';

interface ChannelPanelProps {
  header: React.ReactNode;
  children: React.ReactNode;
  /** When true, panel is forced into pinned mode and the unpin button is hidden. */
  forcePin?: boolean;
}

const ChannelPanel: React.FC<ChannelPanelProps> = ({ header, children, forcePin = false }) => {
  const channelPanelPinned = useLayoutStore((s) => s.channelPanelPinned);
  const channelPanelHoverVisible = useLayoutStore((s) => s.channelPanelHoverVisible);
  const toggleChannelPin = useLayoutStore((s) => s.toggleChannelPin);
  const hideChannelPanelHover = useLayoutStore((s) => s.hideChannelPanelHover);
  const reduceAnimations = useSettingsStore((s) => s.appearance.reduceAnimations);

  const panel = useResizablePanel({
    defaultWidth: 240,
    minWidth: 180,
    maxWidth: 400,
    side: 'left',
    storageKey: 'concord:channelPanelWidth',
  });

  const [isHovered, setIsHovered] = useState(false);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const clearHideTimeout = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  const startHideTimeout = useCallback(() => {
    clearHideTimeout();
    hideTimeoutRef.current = setTimeout(
      () => {
        setIsHovered(false);
        hideChannelPanelHover();
      },
      reduceAnimations ? 200 : 1000
    );
  }, [clearHideTimeout, hideChannelPanelHover, reduceAnimations]);

  const handleMouseEnter = useCallback(() => {
    clearHideTimeout();
    setIsHovered(true);
  }, [clearHideTimeout]);

  const handleMouseLeave = useCallback(() => {
    if (!channelPanelPinned) {
      startHideTimeout();
    }
  }, [channelPanelPinned, startHideTimeout]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => clearHideTimeout();
  }, [clearHideTimeout]);

  const effectivelyPinned = channelPanelPinned || forcePin;

  // Pinned mode — standard sidebar
  if (effectivelyPinned) {
    return (
      <>
        <div
          className="channels-sidebar"
          style={{ width: panel.width, display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          <div className="channels-sidebar-header">
            {header}
            {!forcePin && (
              <button
                className="channel-panel-pin-btn"
                onClick={toggleChannelPin}
                title="Unpin channel panel"
                aria-label="Unpin channel panel"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-muted)',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  transition: 'color 0.15s ease',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
              >
                <PinOff size={14} />
              </button>
            )}
          </div>
          {children}
          <UserPanel />
        </div>
        <button
          type="button"
          className="layout-resize-handle"
          onMouseDown={panel.onMouseDown}
          tabIndex={-1}
          aria-hidden="true"
        />
      </>
    );
  }

  // Unpinned mode — overlay dropdown
  const showOverlay = channelPanelHoverVisible || isHovered;

  return (
    <div
      className={`channel-panel-overlay ${showOverlay ? 'slide-in' : 'slide-out'}`}
      style={{ width: panel.width }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="channels-sidebar-header">
        {header}
        <button
          className="channel-panel-pin-btn"
          onClick={toggleChannelPin}
          title="Pin channel panel"
          aria-label="Pin channel panel"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            padding: '4px',
            display: 'flex',
            alignItems: 'center',
            transition: 'color 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
        >
          <Pin size={14} />
        </button>
      </div>
      {children}
    </div>
  );
};

export default ChannelPanel;
