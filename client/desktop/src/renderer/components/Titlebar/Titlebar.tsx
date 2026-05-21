import React, { useEffect, useState } from 'react';
import './Titlebar.css';

interface VersionInfo {
  appVersion: string;
  spaHash: string | null;
}

function formatVersionText(version: VersionInfo | null): string {
  if (version === null) return '';
  if (version.spaHash) return `v${version.appVersion}-${version.spaHash}`;
  return `v${version.appVersion}`;
}

export const Titlebar: React.FC = () => {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const isMac = typeof navigator !== 'undefined' && navigator.platform.includes('Mac');

  useEffect(() => {
    // Defensive `?.` chains: in unit-test environments and during the brief
    // preload-bridge initialization window, `window.electron.version` may not
    // be installed yet. Skipping the fetch + subscription cleanly lets the
    // component render the brand text without crashing.
    const versionApi = globalThis.electron?.version;
    if (!versionApi) {
      return;
    }

    let mounted = true;
    void (async () => {
      try {
        const v = await versionApi.get();
        if (mounted) setVersion(v);
      } catch (err) {
        console.error('[Titlebar] failed to fetch version:', (err as Error).message);
      }
    })();

    const unsubscribe = versionApi.onChange((data) => {
      setVersion((prev) =>
        prev ? { ...prev, spaHash: data.spaHash } : { appVersion: '', spaHash: data.spaHash }
      );
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const versionText = formatVersionText(version);

  return (
    <div className={`titlebar ${isMac ? 'titlebar--mac' : ''}`}>
      <span className="titlebar-title">CONCORD VOICE</span>
      {versionText && <span className="titlebar-version">{versionText}</span>}
    </div>
  );
};
