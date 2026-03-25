import React, { useState, useEffect, useCallback } from 'react';
import CollapsibleSection from './CollapsibleSection';
import ToggleSwitch from './ToggleSwitch';
import './AboutUpdateSection.css';

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

interface DownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

interface SystemInfo {
  platform: string;
  arch: string;
  electronVersion: string;
  chromiumVersion: string;
  nodeVersion: string;
}

function formatPlatform(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}

function formatArch(arch: string): string {
  switch (arch) {
    case 'x64':
      return 'x86_64';
    case 'arm64':
      return 'ARM64';
    case 'ia32':
      return 'x86';
    default:
      return arch;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const AboutUpdateSection: React.FC = () => {
  // Client info state
  const [appVersion, setAppVersion] = useState('');
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  // Update settings state
  const [allowPrerelease, setAllowPrerelease] = useState(true);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateVersion, setUpdateVersion] = useState('');
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  // Load client info on mount
  useEffect(() => {
    globalThis.electron?.getVersion?.().then(setAppVersion);
    globalThis.electron?.getSystemInfo?.().then(setSystemInfo);
    globalThis.electron?.getAllowPrerelease?.().then(setAllowPrerelease);
  }, []);

  // Subscribe to update events
  useEffect(() => {
    if (!globalThis.electron?.onUpdateAvailable) return;

    const cleanups = [
      globalThis.electron.onUpdateAvailable((info) => {
        setUpdateVersion(info.version);
        setUpdateStatus('available');
        setLastChecked(new Date());
      }),
      globalThis.electron.onUpdateNotAvailable(() => {
        setUpdateStatus('up-to-date');
        setLastChecked(new Date());
      }),
      globalThis.electron.onUpdateDownloadProgress((prog) => {
        setUpdateStatus('downloading');
        setProgress(prog);
      }),
      globalThis.electron.onUpdateDownloaded((info) => {
        setUpdateVersion(info.version);
        setUpdateStatus('downloaded');
        setProgress(null);
      }),
      globalThis.electron.onUpdateError((err) => {
        setUpdateStatus('error');
        setErrorMessage(err.message);
      }),
    ];

    return () => {
      for (const fn of cleanups) fn();
    };
  }, []);

  const handleCheckForUpdates = useCallback(async () => {
    setUpdateStatus('checking');
    setErrorMessage('');
    try {
      await globalThis.electron?.checkForUpdates();
    } catch {
      setUpdateStatus('error');
      setErrorMessage('Failed to check for updates.');
    }
  }, []);

  const handleDownload = useCallback(async () => {
    setUpdateStatus('downloading');
    setProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
    try {
      await globalThis.electron?.downloadUpdate();
    } catch (err) {
      // The IPC rejection carries the real electron-updater error.
      // onUpdateError also fires (via a separate IPC channel) with the same info.
      const msg = err instanceof Error ? err.message : String(err);
      setUpdateStatus('error');
      setErrorMessage(msg || 'Download failed.');
      setProgress(null);
    }
  }, []);

  const handleInstall = useCallback(() => {
    globalThis.electron?.installUpdate();
  }, []);

  const handlePrereleaseToggle = useCallback((enabled: boolean) => {
    setAllowPrerelease(enabled);
    globalThis.electron?.setAllowPrerelease?.(enabled);
  }, []);

  return (
    <>
      {/* Client Info */}
      <CollapsibleSection id="section-client-info" title="Client Info" defaultOpen>
        <div className="about-info-grid">
          <div className="about-info-row">
            <span className="about-info-label">App Version</span>
            <span className="about-info-value">v{appVersion || '...'}</span>
          </div>
          {systemInfo && (
            <>
              <div className="about-info-row">
                <span className="about-info-label">Platform</span>
                <span className="about-info-value">
                  {formatPlatform(systemInfo.platform)} ({formatArch(systemInfo.arch)})
                </span>
              </div>
              <div className="about-info-row">
                <span className="about-info-label">Electron</span>
                <span className="about-info-value">v{systemInfo.electronVersion}</span>
              </div>
              <div className="about-info-row">
                <span className="about-info-label">Chromium</span>
                <span className="about-info-value">v{systemInfo.chromiumVersion}</span>
              </div>
              <div className="about-info-row">
                <span className="about-info-label">Node.js</span>
                <span className="about-info-value">v{systemInfo.nodeVersion}</span>
              </div>
            </>
          )}
        </div>

        <div className="about-legal">
          <span className="about-legal-text">BSL 1.1 License &middot; Concord Voice</span>
        </div>
      </CollapsibleSection>

      {/* Update Settings */}
      <CollapsibleSection id="section-update-settings" title="Update Settings" defaultOpen>
        {/* Pre-release toggle */}
        <div className="about-setting-row">
          <div className="about-setting-info">
            <span className="about-setting-label">Allow Pre-release Updates</span>
            <span className="about-setting-description">
              {allowPrerelease
                ? 'Update checks will pull from the pre-release branch. Pre-release versions may contain experimental features and bugs.'
                : 'Update checks will only pull stable releases. You will remain on your current version until a stable release newer than your version is published.'}
            </span>
          </div>
          <ToggleSwitch checked={allowPrerelease} onChange={handlePrereleaseToggle} />
        </div>

        {/* Check for updates */}
        <div className="about-update-check">
          <button
            className="about-update-btn"
            onClick={handleCheckForUpdates}
            disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
          >
            {updateStatus === 'checking' ? 'Checking...' : 'Check for Updates'}
          </button>
          {lastChecked && (
            <span className="about-update-last-checked">
              Last checked: {lastChecked.toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* Update status */}
        {updateStatus !== 'idle' && updateStatus !== 'checking' && (
          <div className={`about-update-status about-update-status--${updateStatus}`}>
            {updateStatus === 'up-to-date' && (
              <div className="about-update-status-row">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                  <path
                    d="M5 8l2 2 4-4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>You&apos;re up to date (v{appVersion})</span>
              </div>
            )}

            {updateStatus === 'available' && (
              <div className="about-update-status-row">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 2v8M5 7l3 3 3-3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M3 12h10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                <span>Update available: v{updateVersion}</span>
                <button className="about-update-action-btn" onClick={handleDownload}>
                  Download
                </button>
              </div>
            )}

            {updateStatus === 'downloading' && (
              <div className="about-update-status-col">
                <div className="about-update-status-row">
                  <span>
                    Downloading{updateVersion ? ` v${updateVersion}` : ''}...
                    {progress ? ` ${progress.percent.toFixed(0)}%` : ''}
                  </span>
                </div>
                {progress && (
                  <>
                    <div className="about-update-progress-bar">
                      <div
                        className="about-update-progress-fill"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </div>
                    <span className="about-update-progress-detail">
                      {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
                      {progress.bytesPerSecond > 0 &&
                        ` \u2014 ${formatBytes(progress.bytesPerSecond)}/s`}
                    </span>
                  </>
                )}
              </div>
            )}

            {updateStatus === 'downloaded' && (
              <div className="about-update-status-row">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M1 8a7 7 0 1114 0A7 7 0 011 8z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <path
                    d="M5 8l2 2 4-4"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>v{updateVersion} ready to install</span>
                <button
                  className="about-update-action-btn about-update-action-btn--primary"
                  onClick={handleInstall}
                >
                  Restart Now
                </button>
              </div>
            )}

            {updateStatus === 'error' && (
              <div className="about-update-status-row">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                  <path
                    d="M8 5v3M8 10.5v.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="about-update-error-text">
                  Update error: {errorMessage || 'Unknown error'}
                </span>
              </div>
            )}
          </div>
        )}
      </CollapsibleSection>
    </>
  );
};

export default AboutUpdateSection;
