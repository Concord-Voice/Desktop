import React from 'react';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import FriendsList from './FriendsList';

const FriendsFlexSpace: React.FC = () => {
  const panel = useResizablePanel({
    defaultWidth: 260,
    minWidth: 160,
    maxWidth: 340,
    side: 'right',
    storageKey: 'concord:friendsPanelWidth',
  });

  return (
    <>
      <div className="layout-resize-handle" onMouseDown={panel.onMouseDown} />
      <div
        className="member-list-container"
        style={{ width: panel.width, display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%' }}
      >
        <FriendsList />
      </div>
    </>
  );
};

export default FriendsFlexSpace;
