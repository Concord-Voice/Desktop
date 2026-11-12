// @vitest-environment node
// #87 R13: main owns two native ceremony kinds (the self-hosted approval and the capture
// move), and at most one of them is open at a time, whichever kind it is.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetModalMutexForTesting,
  modalInFlight,
  tryAcquireModal,
} from '../../../src/main/modalMutex';

describe('cross-kind modal mutex (#87 R13)', () => {
  beforeEach(() => {
    _resetModalMutexForTesting();
  });

  it('starts free', () => {
    expect(modalInFlight()).toBeNull();
  });

  it('returns a release and reports the held kind', () => {
    const release = tryAcquireModal('capture');
    expect(typeof release).toBe('function');
    expect(modalInFlight()).toBe('capture');
  });

  it('refuses the OTHER kind while one is held', () => {
    tryAcquireModal('capture');
    expect(tryAcquireModal('self-hosted-approval')).toBeNull();
    expect(modalInFlight()).toBe('capture');
  });

  it('refuses the SAME kind while it is held', () => {
    tryAcquireModal('self-hosted-approval');
    expect(tryAcquireModal('self-hosted-approval')).toBeNull();
    expect(modalInFlight()).toBe('self-hosted-approval');
  });

  it('after release, the other kind acquires', () => {
    const release = tryAcquireModal('capture');
    release?.();
    expect(modalInFlight()).toBeNull();
    expect(tryAcquireModal('self-hosted-approval')).not.toBeNull();
    expect(modalInFlight()).toBe('self-hosted-approval');
  });

  it('releasing twice is a no-op and never frees a successor', () => {
    const first = tryAcquireModal('capture');
    first?.();
    const second = tryAcquireModal('self-hosted-approval');
    expect(second).not.toBeNull();
    first?.(); // stale release from the first holder
    expect(modalInFlight()).toBe('self-hosted-approval');
    expect(tryAcquireModal('capture')).toBeNull();
    second?.();
    second?.();
    expect(modalInFlight()).toBeNull();
  });

  it('_resetModalMutexForTesting frees a held slot', () => {
    tryAcquireModal('capture');
    _resetModalMutexForTesting();
    expect(modalInFlight()).toBeNull();
    expect(tryAcquireModal('capture')).not.toBeNull();
  });
});
