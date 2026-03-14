import { useEffect, useState, useCallback } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';
import './UpdateBanner.css';

type BannerState = 'hidden' | 'available' | 'downloading' | 'downloaded';

interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

const DISMISSED_KEY = 'concord:update-banner-dismissed';
/** Dismiss expires after 7 days — re-shows the banner for the same version */
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getDismissed(): { version: string; at: number } | null {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === 'string' && typeof parsed.at === 'number') {
      return parsed;
    }
  } catch {
    // Corrupted — remove to stop repeated parse failures
    localStorage.removeItem(DISMISSED_KEY);
  }
  // Migrate legacy format (plain version string)
  const legacy = localStorage.getItem('concord:update-banner-dismissed-version');
  if (legacy) {
    localStorage.removeItem('concord:update-banner-dismissed-version');
    return null;
  }
  return null;
}

const UpdateBanner: React.FC = () => {
  const [state, setState] = useState<BannerState>('hidden');
  const [version, setVersion] = useState('');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState(() => {
    const dismissed = getDismissed();
    if (!dismissed) return '';
    // Expired — clear and re-show
    if (Date.now() - dismissed.at > DISMISS_TTL_MS) {
      localStorage.removeItem(DISMISSED_KEY);
      return '';
    }
    return dismissed.version;
  });

  useEffect(() => {
    if (!window.electron?.onUpdateAvailable) return;

    const cleanups = [
      window.electron.onUpdateAvailable((info) => {
        setVersion(info.version);
        setState('available');
      }),
      window.electron.onUpdateDownloadProgress((prog) => {
        setState('downloading');
        setProgress(prog);
      }),
      window.electron.onUpdateDownloaded((info) => {
        setVersion(info.version);
        setState('downloaded');
        setProgress(null);
      }),
      window.electron.onUpdateNotAvailable(() => {
        // No action — stays hidden or dismissed
      }),
      window.electron.onUpdateError(() => {
        // Reset to available so user can retry; main process logs details
        setState((prev) => (prev === 'downloading' ? 'available' : prev));
        setProgress(null);
      }),
    ];

    return () => cleanups.forEach((fn) => fn());
  }, []);

  const handleDownload = useCallback(async () => {
    setState('downloading');
    setProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    try {
      await window.electron?.downloadUpdate();
    } catch {
      // Reset to available so user can retry; onUpdateError also fires
      setState('available');
      setProgress(null);
    }
  }, []);

  const handleInstall = useCallback(() => {
    window.electron?.installUpdate();
  }, []);

  const handleDismiss = useCallback(() => {
    if (version) {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify({ version, at: Date.now() }));
      setDismissedVersion(version);
    }
  }, [version]);

  if (state === 'hidden' || (dismissedVersion && dismissedVersion === version)) return null;

  return (
    <div className={`update-banner update-banner--${state}`}>
      <div className="update-banner__icon">
        {state === 'downloaded' ? <RefreshCw size={16} /> : <Download size={16} />}
      </div>

      <div className="update-banner__text">
        {state === 'available' && `Update available: v${version}`}
        {state === 'downloading' &&
          `Downloading update\u2026 ${progress ? `${progress.percent.toFixed(0)}%` : ''}`}
        {state === 'downloaded' && `v${version} ready to install`}
      </div>

      <div className="update-banner__actions">
        {state === 'available' && (
          <button className="update-banner__btn primary" onClick={handleDownload}>
            Download
          </button>
        )}
        {state === 'downloaded' && (
          <button className="update-banner__btn primary" onClick={handleInstall}>
            Restart Now
          </button>
        )}
        <button className="update-banner__btn dismiss" onClick={handleDismiss} aria-label="Dismiss">
          <X size={14} />
        </button>
      </div>

      {state === 'downloading' && progress && (
        <div className="update-banner__progress" style={{ width: `${progress.percent}%` }} />
      )}
    </div>
  );
};

export default UpdateBanner;
