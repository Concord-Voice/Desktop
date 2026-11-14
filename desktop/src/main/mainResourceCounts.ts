/**
 * Read-only counts of the per-connection resources main holds (#87 spec R9).
 *
 * No ledger: each figure is read from the map or session that owns the resource, so the
 * view cannot drift from the state it describes. Every owner keys by `ConnectionId` and
 * holds at most one entry per connection, so each field is at most
 * `MAX_LIVE_CONNECTIONS`; the lease and the audiocap session hold at most one at all.
 * Reading starts, stops and mutates nothing. For tests and the churn budget checks (#90).
 */
import { audiocapCaptureActive } from './audiocapHost';
import { captureLeaseCounts } from './captureLease';
import { loopbackCount } from './ipc/sso';
import { traySnapshotCount } from './ipc/trayStatus';

export interface MainResourceCounts {
  readonly captureHolder: 0 | 1;
  readonly handoffPending: 0 | 1;
  readonly loopbacks: number;
  readonly traySnapshots: number;
  readonly audiocapCapture: 0 | 1;
}

export function mainResourceCounts(): MainResourceCounts {
  const lease = captureLeaseCounts();
  return {
    captureHolder: lease.holder,
    handoffPending: lease.handoff,
    loopbacks: loopbackCount(),
    traySnapshots: traySnapshotCount(),
    audiocapCapture: audiocapCaptureActive() ? 1 : 0,
  };
}
