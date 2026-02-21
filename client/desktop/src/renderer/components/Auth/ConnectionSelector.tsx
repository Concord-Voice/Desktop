import React, { useState } from 'react';
import { ConnectionMode } from '../../types/auth';
import './ConnectionSelector.css';

interface ConnectionSelectorProps {
  onSelect: (mode: ConnectionMode) => void;
}

const ConnectionSelector: React.FC<ConnectionSelectorProps> = ({ onSelect }) => {
  const [selectedMode, setSelectedMode] = useState<ConnectionMode | null>(null);

  const handleModeChange = (mode: ConnectionMode) => {
    setSelectedMode(mode);
  };

  const handleContinue = () => {
    if (selectedMode) {
      onSelect(selectedMode);
    }
  };

  return (
    <div className="connection-selector">
      <div className="connection-content">
        {/* Logo and Tagline */}
        <div className="connection-header">
          <img
            src="./branding/logos/main-logo-transparent-vector.svg"
            alt="Concord"
            className="connection-logo"
          />
        </div>

        {/* Connection Options */}
        <div className="connection-options">
          <label
            className={`connection-option ${selectedMode === 'hosted-login' ? 'selected' : ''}`}
            onClick={() => handleModeChange('hosted-login')}
          >
            <div className="option-radio">
              <div className="radio-outer">
                {selectedMode === 'hosted-login' && <div className="radio-inner" />}
              </div>
            </div>
            <div className="option-content">
              <div className="option-title">Sign In to Existing Account</div>
              <div className="option-description">
                <div className="option-feature">• Already have a Concord account</div>
                <div className="option-feature">• Access your servers and communities</div>
                <div className="option-feature">• Secure E2EE authentication</div>
              </div>
            </div>
          </label>

          <label
            className={`connection-option ${selectedMode === 'hosted' ? 'selected' : ''}`}
            onClick={() => handleModeChange('hosted')}
          >
            <div className="option-radio">
              <div className="radio-outer">
                {selectedMode === 'hosted' && <div className="radio-inner" />}
              </div>
            </div>
            <div className="option-content">
              <div className="option-title">Create New Account</div>
              <div className="option-description">
                <div className="option-feature">• New to Concord? Start here</div>
                <div className="option-feature">• Access public servers and communities</div>
                <div className="option-feature">• Add self-hosted servers later</div>
              </div>
            </div>
          </label>

          <label
            className={`connection-option ${selectedMode === 'self-hosted' ? 'selected' : ''}`}
            onClick={() => handleModeChange('self-hosted')}
          >
            <div className="option-radio">
              <div className="radio-outer">
                {selectedMode === 'self-hosted' && <div className="radio-inner" />}
              </div>
            </div>
            <div className="option-content">
              <div className="option-title">Connect to Self-Hosted Server</div>
              <div className="option-description">
                <div className="option-feature">• Private and independent</div>
                <div className="option-feature">• No hosted account required</div>
                <div className="option-feature">• Complete control over your data</div>
              </div>
            </div>
          </label>
        </div>

        {/* Continue Button */}
        <button className="connection-continue" disabled={!selectedMode} onClick={handleContinue}>
          Continue
        </button>

        {/* Footer Links */}
        <div className="connection-footer">
          <a href="#" className="footer-link">
            Learn about self-hosting
          </a>
        </div>
      </div>
    </div>
  );
};

export default ConnectionSelector;
