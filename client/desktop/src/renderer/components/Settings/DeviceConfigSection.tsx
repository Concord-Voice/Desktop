import React from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import DeviceSelector from '../Voice/DeviceSelector';
import { useMicTest } from '../../hooks/useMicTest';
import { useDraftAudioSetting, setDraftAudioSetting } from '../../hooks/useDraftSettings';
import CollapsibleSection from './CollapsibleSection';

const DeviceConfigSection: React.FC = () => {
  const inputVolume = useDraftAudioSetting('inputVolume');
  const outputVolume = useDraftAudioSetting('outputVolume');
  const isInVoiceCall = useVoiceStore(
    (s) =>
      s.connectionState === 'connected' ||
      s.connectionState === 'connecting' ||
      s.connectionState === 'reconnecting'
  );
  const { isTesting, dbfsLevel, error: micTestError, startTest, stopTest } = useMicTest();

  return (
    <CollapsibleSection id="section-device-config" title="Device Configuration">
      <h3 className="settings-subsection-title">Input</h3>
      <div className="settings-device-row">
        <DeviceSelector kind="audioinput" />
      </div>
      <div className="settings-volume-row">
        <div className="settings-row-info">
          <span className="settings-volume-label">Input Volume</span>
          <span className="settings-row-hint">
            Scales your microphone level from muted (left) to 2x boost (right). Values above 100%
            may introduce clipping.
          </span>
        </div>
        <div className="settings-slider-wrapper">
          <span className="settings-slider-value">{inputVolume}%</span>
          <input
            type="range"
            className="settings-volume-slider"
            min={0}
            max={200}
            value={inputVolume}
            onChange={(e) => setDraftAudioSetting('inputVolume', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="settings-mic-test-row">
        <button
          className={`settings-mic-test-btn${isTesting ? ' testing' : ''}`}
          onClick={isTesting ? stopTest : startTest}
          disabled={isInVoiceCall}
          title={isInVoiceCall ? 'Unavailable during a voice call' : undefined}
        >
          {isTesting ? 'Stop Testing' : 'Test'}
        </button>
        {micTestError && <span className="settings-mic-test-error">{micTestError}</span>}
      </div>

      {isTesting && (
        <div className="settings-mic-meter-container">
          <div className="settings-mic-meter-track">
            <div
              className="settings-mic-meter-fill"
              style={{ width: `${Math.max(0, ((dbfsLevel + 80) / 80) * 100)}%` }}
            />
          </div>
          <div className="settings-mic-meter-ticks">
            <span>-80</span>
            <span>-60</span>
            <span>-40</span>
            <span>-20</span>
            <span>0 dBFS</span>
          </div>
        </div>
      )}

      <h3 className="settings-subsection-title">Output</h3>
      <div className="settings-device-row">
        <DeviceSelector kind="audiooutput" />
      </div>
      <div className="settings-volume-row">
        <div className="settings-row-info">
          <span className="settings-volume-label">Output Volume</span>
          <span className="settings-row-hint">
            Scales all incoming audio from muted (left) to 2x boost (right). Values above 100% may
            introduce clipping.
          </span>
        </div>
        <div className="settings-slider-wrapper">
          <span className="settings-slider-value">{outputVolume}%</span>
          <input
            type="range"
            className="settings-volume-slider"
            min={0}
            max={200}
            value={outputVolume}
            onChange={(e) => setDraftAudioSetting('outputVolume', Number(e.target.value))}
          />
        </div>
      </div>

      <h3 className="settings-subsection-title">Camera</h3>
      <div className="settings-device-row">
        <DeviceSelector kind="videoinput" />
      </div>
    </CollapsibleSection>
  );
};

export default DeviceConfigSection;
