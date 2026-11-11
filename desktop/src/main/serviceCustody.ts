/**
 * Where a service's credential custody is minted (#86 Task 7B, exit criterion S1).
 *
 * The connection registry calls this once per service, through its `makeCustody`
 * dependency, while it builds the service record. Every other main-process reader
 * reaches custody through that record: an IPC handler through its sender's binding
 * (`sender.service.custody`), a main-initiated fan-out such as `powerMonitor
 * 'resume'` by iterating the registered services. No handler file names a custody
 * by API base, origin or pointer, so none can pick another service's credential.
 */
import type { ServiceId } from '../shared/connectionIdentity';
import { custodyFor, type ProactiveRefreshCallback, type ProfileCustody } from './tokenManager';

/**
 * The custody for `serviceId` at `origin`, with its proactive refreshes routed to
 * `onProactiveRefresh` tagged by that same service, so a refresh can only ever be
 * delivered to the service that made it.
 */
export function makeServiceCustody(
  serviceId: ServiceId,
  origin: string,
  onProactiveRefresh: (serviceId: ServiceId, ...args: Parameters<ProactiveRefreshCallback>) => void
): ProfileCustody {
  const custody = custodyFor(serviceId, origin);
  custody.setProactiveRefreshCallback((accessToken, sessionId, previousSessionId) => {
    onProactiveRefresh(serviceId, accessToken, sessionId, previousSessionId);
  });
  return custody;
}
