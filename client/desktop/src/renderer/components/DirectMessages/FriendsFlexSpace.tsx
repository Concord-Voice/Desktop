import React from 'react';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import FriendsList from './FriendsList';

interface FriendsFlexSpaceProps {
  onFriendClick?: (userId: string) => void;
}

const FriendsFlexSpace: React.FC<FriendsFlexSpaceProps> = ({ onFriendClick }) => {
  const panel = useResizablePanel({
    defaultWidth: 260,
    minWidth: 160,
    maxWidth: 340,
    side: 'right',
    storageKey: 'concord:friendsPanelWidth',
  });

  return (
    <>
      <button
        type="button"
        className="layout-resize-handle"
        onMouseDown={panel.onMouseDown}
        tabIndex={-1}
        aria-hidden="true"
      />
      <div
        className="member-list-container"
        style={{
          width: panel.width,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          height: '100%',
        }}
      >
        <FriendsList onFriendClick={onFriendClick} />
      </div>
    </>
  );
};

export default FriendsFlexSpace;
