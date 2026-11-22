import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameKeyProvisionGate } from '@/renderer/services/e2ee/frameKeyProvisionGate';

describe('FrameKeyProvisionGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('refuses frame-stamped future versions and epochs before spending a budget', () => {
    const gate = new FrameKeyProvisionGate();
    expect(gate.admit('sender', 2, 0, 1, 0)).toBeNull();
    expect(gate.admit('sender', 1, 100, 1, 0)).toBeNull();
    expect(gate.admit('sender', 1, 0, 1, 0)).not.toBeNull();
  });

  it('deduplicates in flight and shares an eight-request sender limit across callers', () => {
    const gate = new FrameKeyProvisionGate();
    for (let i = 0; i < 8; i++) {
      const token = gate.admit('sender', 1, 0, 1, 0);
      expect(token).not.toBeNull();
      expect(gate.admit('sender', 1, 0, 1, 0)).toBeNull();
      if (token === null) throw new Error('expected admitted request');
      gate.release(token);
    }
    expect(gate.admit('sender', 1, 0, 1, 0)).toBeNull();
    vi.advanceTimersByTime(15_000);
    expect(gate.admit('sender', 1, 0, 1, 0)).not.toBeNull();
  });

  it('bounds aggregate requests and frame-driven ratchet steps', () => {
    const gate = new FrameKeyProvisionGate();
    for (let i = 0; i < 64; i++) {
      const token = gate.admit(`sender-${i}`, 1, 0, 1, 0);
      expect(token).not.toBeNull();
      if (token === null) throw new Error('expected admitted request');
      gate.release(token);
    }
    expect(gate.admit('sender-overflow', 1, 0, 1, 0)).toBeNull();
    vi.advanceTimersByTime(15_000);
    for (let i = 0; i < 2; i++) {
      const token = gate.admit(`expensive-${i}`, 1, 100, 1, 100);
      expect(token).not.toBeNull();
      if (token === null) throw new Error('expected admitted request');
      gate.release(token);
    }
    expect(gate.admit('expensive-2', 1, 100, 1, 100)).toBeNull();
    expect(gate.admit('expensive-0', 1, 100, 1, 100)).toBeNull();
  });

  it('does not let a stale session release a new session request', () => {
    const gate = new FrameKeyProvisionGate();
    const old = gate.admit('sender', 1, 0, 1, 0);
    expect(old).not.toBeNull();
    gate.clear();
    const current = gate.admit('sender', 1, 0, 1, 0);
    expect(current).not.toBeNull();
    if (old === null || current === null) throw new Error('expected admitted requests');
    gate.release(old);
    expect(gate.admit('sender', 1, 0, 1, 0)).toBeNull();
    gate.release(current);
    expect(gate.admit('sender', 1, 0, 1, 0)).not.toBeNull();
  });
});
