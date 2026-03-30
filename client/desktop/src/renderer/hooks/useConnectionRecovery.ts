/**
 * useConnectionRecovery - Connection loss detection and phased recovery logic.
 *
 * Extracted from useWebSocket to isolate the reconnection state machine.
 * Returns a callback that maps ConnectionState changes to recovery actions.
 */

import { useCallback } from 'react';
import { ConnectionState, getWebSocketService } from '../services/websocketService';
import { e2eeService } from '../services/e2eeService';
import { useConnectionStore } from '../stores/connectionStore';
import { useUserStore } from '../stores/userStore';
import { useVoiceStore } from '../stores/voiceStore';

/** Run preflight diagnostics after grace period expires and route to the appropriate recovery path. */
async function runPreflightDiagnostics(wsService: ReturnType<typeof getWebSocketService>) {
  if (wsService.getState() === ConnectionState.CONNECTED) return;

  wsService.setAggressiveReconnect(false);
  const store = useConnectionStore.getState();
  if (store.phase !== 'grace_period') return;

  store.enterPreflight();
  const { runPreflight } = await import('../services/recoveryService');
  const diag = await runPreflight();
  store.setDiagnostics(diag);

  if (diag.sessionRevoked) {
    store.enterFatal();
    return;
  }

  if (!diag.internet || !diag.serverReachable) {
    store.enterRecoveryA();
    return;
  }

  if (diag.tokenValid && !diag.rendererStable) {
    store.enterRecoveryB();
    const { softRestart } = await import('../services/resetService');
    softRestart();
    return;
  }

  if (diag.tokenValid) {
    store.enterRecoveryA();
    return;
  }

  store.enterRecoveryB();
  const { softRestart } = await import('../services/resetService');
  softRestart();
}

/** Handle recovery when connection drops (RECONNECTING state). */
function handleConnectionLoss(wsService: ReturnType<typeof getWebSocketService>) {
  const connStore = useConnectionStore.getState();
  if (connStore.phase !== 'stable') return;

  connStore.startGracePeriod();
  wsService.setAggressiveReconnect(true);

  const voiceState = useVoiceStore.getState();
  if (voiceState.connectionState !== 'disconnected' && voiceState.activeChannelId) {
    connStore.setLastVoiceChannelId(voiceState.activeChannelId);
  }

  import('../services/voiceService')
    .then(({ voiceService }) => {
      if (useVoiceStore.getState().connectionState !== 'disconnected') {
        voiceService.emergencyCleanup();
      }
    })
    .catch(() => {
      /* voice module never loaded */
    });

  setTimeout(() => {
    runPreflightDiagnostics(wsService).catch(console.debug);
  }, 15_000);
}

/** Handle reconnection success (CONNECTED state). */
function handleReconnected(
  wsService: ReturnType<typeof getWebSocketService>,
  validateEpochsOnReconnect: () => Promise<void>
) {
  const phase = useConnectionStore.getState().phase;
  wsService.setAggressiveReconnect(false);

  if (phase === 'recovery_a' || phase === 'preflight') {
    import('../services/resetService').then((m) => m.gracefulReset());
    useConnectionStore.getState().reset();
    useUserStore.getState().fetchUser();
    import('../services/recoveryService').then((m) => m.clearCrashFlag());
    if (e2eeService.isInitialized) validateEpochsOnReconnect().catch(() => {});
    return;
  }

  if (phase === 'grace_period') {
    useConnectionStore.getState().reset();
    if (e2eeService.isInitialized) {
      e2eeService.processPendingKeyRequests().catch(() => {});
      validateEpochsOnReconnect().catch((err) => {
        console.debug('[WebSocket] validate_epochs failed:', err);
      });
    }
    const lastVoiceId = useConnectionStore.getState().lastVoiceChannelId;
    if (lastVoiceId) {
      useConnectionStore.getState().setLastVoiceChannelId(null);
      import('../services/voiceService')
        .then(({ voiceService }) => voiceService.joinChannel(lastVoiceId))
        .catch(() => {
          /* voice module not available */
        });
    }
    return;
  }

  if (phase !== 'stable') {
    useConnectionStore.getState().reset();
  }
}

export function useConnectionRecovery(
  wsService: ReturnType<typeof getWebSocketService>,
  validateEpochsOnReconnect: () => Promise<void>
): (state: ConnectionState) => void {
  return useCallback(
    (state: ConnectionState) => {
      if (state === ConnectionState.RECONNECTING) {
        handleConnectionLoss(wsService);
      } else if (state === ConnectionState.CONNECTED) {
        handleReconnected(wsService, validateEpochsOnReconnect);
      }
    },
    [wsService, validateEpochsOnReconnect]
  );
}
