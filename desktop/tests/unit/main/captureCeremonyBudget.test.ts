// @vitest-environment node
// #87 §3.3: the capture-move dialog is rationed by a token bucket of its own,
// capacity 3, refilled one token per 20 s.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CAPTURE_CEREMONY_CAPACITY,
  CAPTURE_CEREMONY_REFILL_MS,
  _resetCaptureCeremonyBudgetForTesting,
  consumeCaptureCeremonyToken,
} from '../../../src/main/captureCeremonyBudget';

const t0 = 1_000_000;

describe('capture ceremony token bucket (#87)', () => {
  beforeEach(() => {
    _resetCaptureCeremonyBudgetForTesting();
  });

  it('is capacity 3, refilled one per 20 s', () => {
    expect(CAPTURE_CEREMONY_CAPACITY).toBe(3);
    expect(CAPTURE_CEREMONY_REFILL_MS).toBe(20_000);
  });

  it('admits three at one instant, then refuses the fourth', () => {
    expect(consumeCaptureCeremonyToken(t0)).toBe(true);
    expect(consumeCaptureCeremonyToken(t0)).toBe(true);
    expect(consumeCaptureCeremonyToken(t0)).toBe(true);
    expect(consumeCaptureCeremonyToken(t0)).toBe(false);
  });

  it('refills exactly one token after 20 s', () => {
    for (let i = 0; i < 3; i++) consumeCaptureCeremonyToken(t0);
    expect(consumeCaptureCeremonyToken(t0 + 19_999)).toBe(false);
    expect(consumeCaptureCeremonyToken(t0 + 20_000)).toBe(true);
    expect(consumeCaptureCeremonyToken(t0 + 20_000)).toBe(false);
  });

  it('refills to capacity after 60 s, and never above it', () => {
    for (let i = 0; i < 3; i++) consumeCaptureCeremonyToken(t0);
    expect(consumeCaptureCeremonyToken(t0 + 60_000)).toBe(true);
    expect(consumeCaptureCeremonyToken(t0 + 60_000)).toBe(true);
    expect(consumeCaptureCeremonyToken(t0 + 60_000)).toBe(true);
    expect(consumeCaptureCeremonyToken(t0 + 60_000)).toBe(false);
    // A long idle stretch still yields only capacity.
    _resetCaptureCeremonyBudgetForTesting();
    for (let i = 0; i < 3; i++) consumeCaptureCeremonyToken(t0);
    for (let i = 0; i < 3; i++) expect(consumeCaptureCeremonyToken(t0 + 600_000)).toBe(true);
    expect(consumeCaptureCeremonyToken(t0 + 600_000)).toBe(false);
  });

  it('a refused call spends nothing and does not move the refill clock', () => {
    for (let i = 0; i < 3; i++) consumeCaptureCeremonyToken(t0);
    expect(consumeCaptureCeremonyToken(t0 + 10_000)).toBe(false);
    expect(consumeCaptureCeremonyToken(t0 + 20_000)).toBe(true);
  });

  it('a full bucket accrues nothing: the first refill is 20 s after the first spend', () => {
    // Idle with a full bucket, then spend all three well after the reset.
    for (let i = 0; i < 3; i++) consumeCaptureCeremonyToken(t0 + 50_000);
    expect(consumeCaptureCeremonyToken(t0 + 50_001)).toBe(false);
    expect(consumeCaptureCeremonyToken(t0 + 69_999)).toBe(false);
    expect(consumeCaptureCeremonyToken(t0 + 70_000)).toBe(true);
  });

  it('a clock that moves backwards refills nothing', () => {
    for (let i = 0; i < 3; i++) consumeCaptureCeremonyToken(t0);
    expect(consumeCaptureCeremonyToken(t0 - 60_000)).toBe(false);
    expect(consumeCaptureCeremonyToken(t0 + 20_000)).toBe(true);
  });

  it('refuses a non-finite timestamp without spending', () => {
    expect(consumeCaptureCeremonyToken(Number.NaN)).toBe(false);
    expect(consumeCaptureCeremonyToken(Number.POSITIVE_INFINITY)).toBe(false);
    for (let i = 0; i < 3; i++) expect(consumeCaptureCeremonyToken(t0)).toBe(true);
  });

  it('_resetCaptureCeremonyBudgetForTesting restores capacity', () => {
    for (let i = 0; i < 3; i++) consumeCaptureCeremonyToken(t0);
    expect(consumeCaptureCeremonyToken(t0)).toBe(false);
    _resetCaptureCeremonyBudgetForTesting();
    expect(consumeCaptureCeremonyToken(t0)).toBe(true);
  });

  it('defaults to the wall clock when no timestamp is supplied', () => {
    expect(consumeCaptureCeremonyToken()).toBe(true);
  });
});
