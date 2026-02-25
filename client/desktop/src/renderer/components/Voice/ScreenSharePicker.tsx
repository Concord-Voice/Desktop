import React, { useState, useEffect, useCallback } from 'react';
import { Monitor, X } from 'lucide-react';
import { useVideoSettingsStore } from '../../stores/videoSettingsStore';
import type { ScreenResolution, ScreenContentType } from '../../stores/videoSettingsStore';
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
    [onCancel],
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
                          <img
                            src={source.appIcon}
                            alt=""
                            className="screen-picker__app-icon"
                          />
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
            <select
              className="screen-picker__quality-select"
              value={useVideoSettingsStore.getState().screenResolution}
              onChange={(e) => useVideoSettingsStore.getState().setScreenResolution(e.target.value as ScreenResolution)}
            >
              <option value="source">Source Native</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
            </select>
          </div>
          <div className="screen-picker__quality-row">
            <label className="screen-picker__quality-label">Frame Rate</label>
            <select
              className="screen-picker__quality-select"
              value={useVideoSettingsStore.getState().screenFrameRate}
              onChange={(e) => useVideoSettingsStore.getState().setScreenFrameRate(Number(e.target.value) as 5 | 15 | 30 | 60)}
            >
              <option value={5}>5 FPS</option>
              <option value={15}>15 FPS</option>
              <option value={30}>30 FPS</option>
              <option value={60}>60 FPS</option>
            </select>
          </div>
          <div className="screen-picker__quality-row">
            <label className="screen-picker__quality-label">Content</label>
            <select
              className="screen-picker__quality-select"
              value={useVideoSettingsStore.getState().screenContentType}
              onChange={(e) => useVideoSettingsStore.getState().setScreenContentType(e.target.value as ScreenContentType)}
            >
              <option value="auto">Auto</option>
              <option value="motion">Motion (video)</option>
              <option value="detail">Detail (text/code)</option>
            </select>
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
