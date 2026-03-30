import React, { useCallback, useRef } from 'react';
import { useLayoutStore } from '../../stores/layoutStore';
import './AppLayout.css';

interface AppLayoutProps {
  serverBar: React.ReactNode;
  folderBar: React.ReactNode;
  channelPanel: React.ReactNode;
  chatArea: React.ReactNode;
  memberSpace: React.ReactNode;
  /** Force the channel panel column to be visible regardless of pin state */
  forceChannelPin?: boolean;
  /** Force the member panel column to expanded mode regardless of layoutStore state */
  forceMemberExpanded?: boolean;
}

const AppLayout: React.FC<AppLayoutProps> = ({
  serverBar,
  folderBar,
  channelPanel,
  chatArea,
  memberSpace,
  forceChannelPin = false,
  forceMemberExpanded = false,
}) => {
  const channelPanelPinned = useLayoutStore((s) => s.channelPanelPinned);
  const memberPanelMode = useLayoutStore((s) => s.memberPanelMode);
  const setServerBarHeight = useLayoutStore((s) => s.setServerBarHeight);
  const setFolderBarHeight = useLayoutStore((s) => s.setFolderBarHeight);
  const serverBarHeight = useLayoutStore((s) => s.serverBarHeight);
  const folderBarHeight = useLayoutStore((s) => s.folderBarHeight);

  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const makeResizeHandler = useCallback(
    (setter: (h: number) => void) => (e: React.MouseEvent) => {
      e.preventDefault();
      startYRef.current = e.clientY;
      const parentEl = (e.target as HTMLElement).previousElementSibling;
      startHeightRef.current = parentEl ? parentEl.getBoundingClientRect().height : 48;

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientY - startYRef.current;
        setter(startHeightRef.current + delta);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    []
  );

  return (
    <div
      className="app-layout"
      data-channel-pinned={String(channelPanelPinned || forceChannelPin)}
      data-member-mode={forceMemberExpanded ? 'expanded' : memberPanelMode}
    >
      <div className="layout-server-bar" style={{ height: serverBarHeight }}>
        {serverBar}
      </div>
      <button
        type="button"
        className="layout-server-bar-resize layout-resize-handle-h"
        onMouseDown={makeResizeHandler(setServerBarHeight)}
        tabIndex={-1}
        aria-hidden="true"
      />
      <div className="layout-folder-bar" style={{ height: folderBarHeight }}>
        {folderBar}
      </div>
      <button
        type="button"
        className="layout-folder-bar-resize layout-resize-handle-h"
        onMouseDown={makeResizeHandler(setFolderBarHeight)}
        tabIndex={-1}
        aria-hidden="true"
      />
      <div className="layout-channel-panel">{channelPanel}</div>
      <div className="layout-chat-area">{chatArea}</div>
      <div className="layout-member-space">{memberSpace}</div>
    </div>
  );
};

export default AppLayout;
