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

export function useConnectionRecovery(
  wsService: ReturnType<typeof getWebSocketService>,
  validateEpochsOnReconnect: () => Promise<void>
): (state: ConnectionState) => void {
  return useCallback(
    (state: ConnectionState) => {
      // ── Connection loss detection & phased recovery ──────────────
      const connStore = useConnectionStore.getState();

      if (state === ConnectionState.RECONNECTING && connStore.phase === 'stable') {
        // Connection just dropped — start 15-second aggressive grace period
        connStore.startGracePeriod();
        wsService.setAggressiveReconnect(true);

        // Capture voice channel before cleanup so we can rejoin on grace-period reconnect
        const voiceState = useVoiceStore.getState();
        if (voiceState.connectionState !== 'disconnected' && voiceState.activeChannelId) {
          connStore.setLastVoiceChannelId(voiceState.activeChannelId);
        }

        // Emergency-stop voice (don't keep broadcasting while disconnected)
        import('../services/voiceService')
          .then(({ voiceService }) => {
            if (useVoiceStore.getState().connectionState !== 'disconnected') {
              voiceService.emergencyCleanup();
            }
          })
          .catch(() => {
            /* voice module never loaded */
          });

        // After 15s grace period, run preflight diagnostics
        setTimeout(async () => {
          // Reconnected in time — nothing to do
          if (wsService.getState() === ConnectionState.CONNECTED) return;

          wsService.setAggressiveReconnect(false);
          const store = useConnectionStore.getState();
          if (store.phase !== 'grace_period') return; // Already transitioned (e.g. session_revoked)

          store.enterPreflight();

          const { runPreflight } = await import('../services/recoveryService');
          const diag = await runPreflight();
          store.setDiagnostics(diag);

          if (diag.sessionRevoked) {
            store.enterFatal();
            return;
          }

          if (!diag.internet || (diag.internet && !diag.serverReachable)) {
            // Option A: No internet or server unreachable — wait for reconnect
            store.enterRecoveryA();
            return;
          }

          if (diag.serverReachable && diag.tokenValid && !diag.rendererStable) {
            // Option B: Server fine, client had issues — soft restart
            store.enterRecoveryB();
            const { softRestart } = await import('../services/resetService');
            softRestart();
            return;
          }

          if (diag.serverReachable && diag.tokenValid) {
            // Server reachable, token valid, renderer stable — WS glitch, wait for reconnect
            store.enterRecoveryA();
            return;
          }

          // Fallback: try soft restart
          store.enterRecoveryB();
          const { softRestart } = await import('../services/resetService');
          softRestart();
        }, 15_000);
      }

      if (state === ConnectionState.CONNECTED) {
        const phase = connStore.phase;
        wsService.setAggressiveReconnect(false);

        if (phase === 'recovery_a' || phase === 'preflight') {
          // Reconnected during recovery — do graceful content refresh
          import('../services/resetService').then((m) => m.gracefulReset());
          useConnectionStore.getState().reset();
          useUserStore.getState().fetchUser();
          import('../services/recoveryService').then((m) => m.clearCrashFlag());

          // Validate key epochs after extended disconnection
          if (e2eeService.isInitialized) {
            validateEpochsOnReconnect().catch(() => {});
          }
          return;
        }

        if (phase === 'grace_period') {
          // Reconnected within grace period — seamless recovery
          useConnectionStore.getState().reset();

          if (e2eeService.isInitialized) {
            e2eeService.processPendingKeyRequests().catch(() => {
              // Non-critical — will retry on next key_needed event
            });

            // Validate key epochs on reconnect (catch up on missed key_revocation events)
            validateEpochsOnReconnect().catch((err) => {
              console.debug('[WebSocket] validate_epochs failed:', err);
            });
          }

          // Rejoin voice channel if we were in one before the disconnect
          const lastVoiceId = useConnectionStore.getState().lastVoiceChannelId;
          if (lastVoiceId) {
            useConnectionStore.getState().setLastVoiceChannelId(null);
            import('../services/voiceService')
              .then(({ voiceService }) => {
                voiceService.joinChannel(lastVoiceId);
              })
              .catch(() => {
                /* voice module not available */
              });
          }
          return;
        }

        // Any other phase (stable = initial connect, or unexpected): just reset
        if (phase !== 'stable') {
          useConnectionStore.getState().reset();
        }
      }
    },
    [wsService, validateEpochsOnReconnect]
  );
}
