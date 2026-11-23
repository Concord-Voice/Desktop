/**
 * Shared admission for frame-triggered exact-key provisioning. The Worker and
 * legacy transforms both reach VoiceService; PiP exact-key requests use the
 * same instance. A frame stamp cannot authorize a new version or epoch.
 */
const WINDOW_MS = 15_000;
const SENDER_REQUESTS = 8;
const GLOBAL_REQUESTS = 64;
const SENDER_RATCHET_STEPS = 100;
const GLOBAL_RATCHET_STEPS = 200;
const MAX_TRACKED_SENDERS = 2048;

interface Budget {
  start: number;
  requests: number;
  steps: number;
}

export class FrameKeyProvisionGate {
  private readonly senders = new Map<string, Budget>();
  private global: Budget = { start: 0, requests: 0, steps: 0 };
  private readonly inFlight = new Set<string>();
  private generation = 0;

  admit(
    senderUserId: string,
    keyVersion: number,
    keyId: number,
    currentVersion: number,
    currentId: number
  ): string | null {
    if (
      !senderUserId ||
      !Number.isSafeInteger(keyVersion) ||
      !Number.isSafeInteger(keyId) ||
      keyVersion <= 0 ||
      keyId < 0 ||
      keyId > 100 ||
      keyVersion !== currentVersion ||
      keyId !== currentId
    ) {
      return null;
    }

    const token = `${this.generation}:${senderUserId}:${keyVersion}:${keyId}`;
    if (this.inFlight.has(token)) return null;
    const now = Date.now();
    const previous = this.senders.get(senderUserId);
    const sender =
      previous && now - previous.start < WINDOW_MS
        ? previous
        : { start: now, requests: 0, steps: 0 };
    const global =
      now - this.global.start < WINDOW_MS ? this.global : { start: now, requests: 0, steps: 0 };
    if (
      sender.requests >= SENDER_REQUESTS ||
      global.requests >= GLOBAL_REQUESTS ||
      sender.steps + keyId > SENDER_RATCHET_STEPS ||
      global.steps + keyId > GLOBAL_RATCHET_STEPS
    ) {
      return null;
    }

    this.senders.delete(senderUserId);
    this.senders.set(senderUserId, {
      start: sender.start,
      requests: sender.requests + 1,
      steps: sender.steps + keyId,
    });
    while (this.senders.size > MAX_TRACKED_SENDERS) {
      const oldest = this.senders.keys().next().value;
      if (oldest !== undefined) this.senders.delete(oldest);
    }
    this.global = {
      start: global.start,
      requests: global.requests + 1,
      steps: global.steps + keyId,
    };
    this.inFlight.add(token);
    return token;
  }

  release(token: string): void {
    this.inFlight.delete(token);
  }

  clear(): void {
    this.generation++;
    this.senders.clear();
    this.global = { start: 0, requests: 0, steps: 0 };
    this.inFlight.clear();
  }
}
