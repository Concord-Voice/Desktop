import React, { useState, useEffect } from 'react';
import { useDraftTtsSetting, setDraftTtsSetting } from '../../hooks/useDraftSettings';
import ToggleSwitch from './ToggleSwitch';
import CollapsibleSection from './CollapsibleSection';
import CustomSelect from '../ui/CustomSelect';

// ─── Text-to-Speech Section ─────────────────────────────────────────────────

const TTSSection: React.FC = () => {
  const ttsEnabled = useDraftTtsSetting('ttsEnabled');
  const ttsVoice = useDraftTtsSetting('ttsVoice');
  const ttsRate = useDraftTtsSetting('ttsRate');
  const ttsVolume = useDraftTtsSetting('ttsVolume');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const loadVoices = () => {
      const available = globalThis.speechSynthesis?.getVoices() ?? [];
      setVoices(available);
    };
    loadVoices();
    globalThis.speechSynthesis?.addEventListener('voiceschanged', loadVoices);
    return () => globalThis.speechSynthesis?.removeEventListener('voiceschanged', loadVoices);
  }, []);

  const handlePreview = () => {
    if (!globalThis.speechSynthesis) return;
    globalThis.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      'This is a preview of text-to-speech in Concord Voice.'
    );
    utterance.rate = ttsRate;
    utterance.volume = ttsVolume;
    if (ttsVoice) {
      const match = voices.find((v) => v.voiceURI === ttsVoice);
      if (match) utterance.voice = match;
    }
    globalThis.speechSynthesis.speak(utterance);
  };

  return (
    <CollapsibleSection id="section-tts" title="Text-to-Speech">
      <p className="settings-section-description">
        Read voice text chat messages aloud while you&apos;re in a voice channel.
      </p>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Enable TTS Playback</span>
          <span className="settings-row-hint">
            {ttsEnabled
              ? 'Enabled. Incoming voice text chat messages are read aloud while you are in a voice channel.'
              : 'Disabled. Voice text chat messages are displayed as text only.'}
          </span>
        </div>
        <ToggleSwitch checked={ttsEnabled} onChange={(v) => setDraftTtsSetting('ttsEnabled', v)} />
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Voice</span>
          <span className="settings-row-hint">
            {`Select which text-to-speech voice reads messages aloud. Currently using ${ttsVoice ? (voices.find((v) => v.voiceURI === ttsVoice)?.name ?? ttsVoice) : 'System Default'}.`}
          </span>
        </div>
        <CustomSelect
          className="settings-select"
          options={[
            { value: '', label: 'System Default' },
            ...voices.map((v) => ({
              value: v.voiceURI,
              label: `${v.name} (${v.lang})`,
            })),
          ]}
          value={ttsVoice ?? ''}
          onChange={(v) => setDraftTtsSetting('ttsVoice', v || null)}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Speed</span>
          <span className="settings-row-hint">
            Playback speed for text-to-speech. Left (0.5x) for slow speech. Right (2.0x) for
            rapid-fire reading.
          </span>
        </div>
        <div className="settings-slider-wrapper">
          <span className="settings-slider-value">{ttsRate.toFixed(1)}x</span>
          <input
            type="range"
            className="settings-slider"
            min={0.5}
            max={2}
            step={0.1}
            value={ttsRate}
            onChange={(e) => setDraftTtsSetting('ttsRate', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <span className="settings-row-label">Volume</span>
          <span className="settings-row-hint">
            Volume level for text-to-speech playback. Left is muted. Right is full volume.
          </span>
        </div>
        <div className="settings-slider-wrapper">
          <span className="settings-slider-value">{Math.round(ttsVolume * 100)}%</span>
          <input
            type="range"
            className="settings-slider"
            min={0}
            max={1}
            step={0.05}
            value={ttsVolume}
            onChange={(e) => setDraftTtsSetting('ttsVolume', Number(e.target.value))}
          />
        </div>
      </div>

      <div className="settings-row">
        <button className="settings-btn-secondary" onClick={handlePreview}>
          Preview
        </button>
      </div>
    </CollapsibleSection>
  );
};

// ─── Accessibility Section ──────────────────────────────────────────────────

const AccessibilitySection: React.FC = () => <TTSSection />;

export default AccessibilitySection;
