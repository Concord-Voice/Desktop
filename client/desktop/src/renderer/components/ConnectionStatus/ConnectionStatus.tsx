/**
 * ConnectionStatus - Visual indicator of WebSocket connection state
 */

import React from 'react';
import { useChatStore } from '../../stores/chatStore';
import './ConnectionStatus.css';

const ConnectionStatus: React.FC = () => {
  const { isConnected, connectionClientId } = useChatStore();

  if (isConnected) {
    return (
      <div className="connection-status connected" title={`Connected (${connectionClientId})`}>
        <span className="status-dot"></span>
        <span className="status-text">Connected</span>
      </div>
    );
  }

  return (
    <div className="connection-status disconnected" title="Disconnected from server">
      <span className="status-dot"></span>
      <span className="status-text">Offline</span>
    </div>
  );
};

export default ConnectionStatus;
