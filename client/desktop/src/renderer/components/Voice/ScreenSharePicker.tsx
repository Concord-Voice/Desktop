import React, { useState, useEffect, useCallback } from 'react';
import { Monitor, X } from 'lucide-react';
import {
  useVideoSettingsStore,
  type ScreenResolution,
  type ScreenContentType,
} from '../../stores/videoSettingsStore';
import CustomSelect from '../ui/CustomSelect';
import './ScreenSharePicker.css';

interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
}

interface ScreenSharePickerProps {
  onSelect: (sourceId: string) => void;
  onCancel: () => void;
}

const ScreenSharePicker: React.FC<ScreenSharePickerProps> = ({ onSelect, onCancel }) => {
  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const fetchSources = async () => {
      try {
        if (window.electron?.getDesktopSources) {
          const result = await window.electron.getDesktopSources();
          setSources(result);
        }
      } catch (err) {
        console.error('Failed to get desktop sources:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchSources();
  }, []);

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    },
    [onCancel]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  const windows = sources.filter((s) => s.id.startsWith('window:'));

  const handleConfirm = () => {
    if (selected) onSelect(selected);
  };

  return (
    <div className="screen-picker-overlay" onClick={onCancel}>
      <div className="screen-picker" onClick={(e) => e.stopPropagation()}>
        <div className="screen-picker__header">
          <h3 className="screen-picker__title">
            <Monitor size={18} />
            Share Your Screen
          </h3>
          <button className="screen-picker__close" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="screen-picker__loading">Loading sources...</div>
        ) : (
          <div className="screen-picker__content">
            {screens.length > 0 && (
              <div className="screen-picker__section">
                <h4 className="screen-picker__section-title">Screens</h4>
                <div className="screen-picker__grid">
                  {screens.map((source) => (
                    <button
                      key={source.id}
                      className={`screen-picker__source ${
                        selected === source.id ? 'screen-picker__source--selected' : ''
                      }`}
                      onClick={() => setSelected(source.id)}
                    >
                      <img
                        src={source.thumbnail}
                        alt={source.name}
                        className="screen-picker__thumbnail"
                      />
                      <span className="screen-picker__source-name">{source.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {windows.length > 0 && (
              <div className="screen-picker__section">
                <h4 className="screen-picker__section-title">Windows</h4>
                <div className="screen-picker__grid">
                  {windows.map((source) => (
                    <button
                      key={source.id}
                      className={`screen-picker__source ${
                        selected === source.id ? 'screen-picker__source--selected' : ''
                      }`}
                      onClick={() => setSelected(source.id)}
                    >
                      <img
                        src={source.thumbnail}
                        alt={source.name}
                        className="screen-picker__thumbnail"
                      />
                      <div className="screen-picker__source-info">
                        {source.appIcon && (
                          <img src={source.appIcon} alt="" className="screen-picker__app-icon" />
                        )}
                        <span className="screen-picker__source-name">{source.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="screen-picker__quality">
          <div className="screen-picker__quality-row">
            <label className="screen-picker__quality-label">Resolution</label>
            <CustomSelect
              className="screen-picker__quality-select"
              options={[
                { value: 'source', label: 'Source Native' },
                { value: '1080p', label: '1080p' },
                { value: '720p', label: '720p' },
              ]}
              value={useVideoSettingsStore.getState().screenResolution}
              onChange={(v) =>
                useVideoSettingsStore.getState().setScreenResolution(v as ScreenResolution)
              }
            />
          </div>
          <div className="screen-picker__quality-row">
            <label className="screen-picker__quality-label">Frame Rate</label>
            <CustomSelect
              className="screen-picker__quality-select"
              options={[
                { value: '5', label: '5 FPS' },
                { value: '15', label: '15 FPS' },
                { value: '30', label: '30 FPS' },
                { value: '60', label: '60 FPS' },
              ]}
              value={String(useVideoSettingsStore.getState().screenFrameRate)}
              onChange={(v) =>
                useVideoSettingsStore.getState().setScreenFrameRate(Number(v) as 5 | 15 | 30 | 60)
              }
            />
          </div>
          <div className="screen-picker__quality-row">
            <label className="screen-picker__quality-label">Content</label>
            <CustomSelect
              className="screen-picker__quality-select"
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'motion', label: 'Motion (video)' },
                { value: 'detail', label: 'Detail (text/code)' },
              ]}
              value={useVideoSettingsStore.getState().screenContentType}
              onChange={(v) =>
                useVideoSettingsStore.getState().setScreenContentType(v as ScreenContentType)
              }
            />
          </div>
        </div>

        <div className="screen-picker__footer">
          <button className="screen-picker__btn screen-picker__btn--cancel" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="screen-picker__btn screen-picker__btn--confirm"
            onClick={handleConfirm}
            disabled={!selected}
          >
            Share
          </button>
        </div>
      </div>
    </div>
  );
};

export default ScreenSharePicker;
