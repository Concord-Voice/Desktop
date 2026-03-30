import React, { useCallback } from 'react';
import { Loader, RefreshCw, LogOut, AlertTriangle, Wifi } from 'lucide-react';
import {
  useConnectionStore,
  type RecoveryPhase,
  type DiagnosticResults,
} from '../../stores/connectionStore';
// recoveryService & resetService loaded on-demand via dynamic import() to allow code splitting
import './ConnectionLostOverlay.css';

/** Diagnostic checklist shown during recovery phases */
function DiagnosticDisplay({ diagnostics }: Readonly<{ diagnostics: DiagnosticResults | null }>) {
  if (!diagnostics) return null;

  const items = [
    { label: 'Internet', value: diagnostics.internet },
    { label: 'Server', value: diagnostics.serverReachable },
    { label: 'Token', value: diagnostics.tokenValid },
    { label: 'Session', value: !diagnostics.sessionRevoked },
  ];

  return (
    <div className="connection-lost-diagnostics">
      {items.map((item) => {
        let statusText: string;
        if (item.value) statusText = 'OK';
        else if (item.value === false) statusText = 'Failed';
        else statusText = '--';

        return (
          <div key={item.label} className="connection-lost-diag-row">
            <span className="connection-lost-diag-label">{item.label}</span>
            <span className={`connection-lost-diag-value ${item.value ? 'ok' : 'fail'}`}>
              {statusText}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Phase-specific card content */
function PhaseContent({
  phase,
  diagnostics,
}: Readonly<{
  phase: RecoveryPhase;
  diagnostics: DiagnosticResults | null;
}>) {
  const handleRetry = useCallback(async () => {
    const store = useConnectionStore.getState();
    store.enterPreflight();
    const { runPreflight } = await import('../../services/recoveryService');
    const diag = await runPreflight();
    store.setDiagnostics(diag);

    if (diag.sessionRevoked) {
      store.enterFatal();
    } else if (diag.serverReachable && diag.tokenValid) {
      // Things look good — soft restart to reconnect everything
      const { softRestart } = await import('../../services/resetService');
      softRestart();
    } else {
      store.enterRecoveryA();
    }
  }, []);

  const handleRestart = useCallback(async () => {
    const { softRestart } = await import('../../services/resetService');
    softRestart();
  }, []);

  const handleExit = useCallback(() => {
    if (globalThis.electron?.quitApp) {
      globalThis.electron.quitApp();
    } else {
      globalThis.close();
    }
  }, []);

  switch (phase) {
    case 'preflight':
      return (
        <>
          <div className="connection-lost-icon spinning">
            <Loader size={48} />
          </div>
          <h2 className="connection-lost-title">Running Diagnostics</h2>
          <p className="connection-lost-message">
            Checking connectivity and session status&hellip;
          </p>
        </>
      );

    case 'recovery_a':
      return (
        <>
          <div className="connection-lost-icon">
            <Wifi size={48} />
          </div>
          <h2 className="connection-lost-title">
            {diagnostics?.internet === false ? 'No Internet' : 'Waiting for Server'}
          </h2>
          <p className="connection-lost-message">
            {diagnostics?.internet === false
              ? 'Your internet connection appears to be down. Reconnection will happen automatically when connectivity is restored.'
              : 'The server appears to be unreachable. Reconnection attempts are ongoing in the background.'}
          </p>
          <DiagnosticDisplay diagnostics={diagnostics} />
          <div className="connection-lost-actions">
            <button className="connection-lost-btn primary" onClick={handleRetry}>
              <RefreshCw size={16} />
              Retry
            </button>
            <button className="connection-lost-btn secondary" onClick={handleExit}>
              <LogOut size={16} />
              Exit App
            </button>
          </div>
        </>
      );

    case 'recovery_b':
      return (
        <>
          <div className="connection-lost-icon spinning">
            <RefreshCw size={48} />
          </div>
          <h2 className="connection-lost-title">Restarting Client</h2>
          <p className="connection-lost-message">
            Detected a client-side issue. Performing a soft restart to recover your session&hellip;
          </p>
        </>
      );

    case 'fatal':
      return (
        <>
          <div className="connection-lost-icon error">
            <AlertTriangle size={48} />
          </div>
          <h2 className="connection-lost-title">
            {diagnostics?.sessionRevoked ? 'Session Revoked' : 'Connection Failed'}
          </h2>
          <p className="connection-lost-message">
            {diagnostics?.sessionRevoked
              ? 'Your session was terminated by the server. This may happen when logging in from another device or when your session expires.'
              : 'Unable to restore your connection after multiple attempts.'}
          </p>
          <DiagnosticDisplay diagnostics={diagnostics} />
          <div className="connection-lost-actions">
            <button className="connection-lost-btn primary" onClick={handleRestart}>
              <RefreshCw size={16} />
              Restart
            </button>
            <button className="connection-lost-btn secondary" onClick={handleExit}>
              <LogOut size={16} />
              Exit App
            </button>
          </div>
        </>
      );

    default:
      return null;
  }
}

const ConnectionLostOverlay: React.FC = () => {
  const phase = useConnectionStore((s) => s.phase);
  const diagnostics = useConnectionStore((s) => s.diagnostics);

  // Only show overlay for phases beyond grace_period
  if (phase === 'stable' || phase === 'grace_period') return null;

  return (
    <div className="connection-lost-overlay">
      <div className="connection-lost-card">
        <PhaseContent phase={phase} diagnostics={diagnostics} />
      </div>
    </div>
  );
};

export default ConnectionLostOverlay;
