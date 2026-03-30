import React from 'react';

const ToggleSwitch: React.FC<{
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}> = ({ checked, onChange, disabled, label }) => (
  <label className="settings-toggle" aria-label={label || 'Toggle'}>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
    />
    <span className="settings-toggle-track" />
    <span className="settings-toggle-thumb" />
  </label>
);

export default ToggleSwitch;
