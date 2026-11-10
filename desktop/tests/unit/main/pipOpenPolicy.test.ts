import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetPipOpenBudgetForTesting,
  consumePipOpenToken,
  isPipOpenOptions,
} from '@/main/pipOpenPolicy';

beforeEach(() => _resetPipOpenBudgetForTesting());

describe('PiP open admission', () => {
  it.each([
    { id: 'controls-main', width: 480, height: 80, title: 'Concord Voice Controls' },
    { id: 'frames-main', width: 320, height: 240 },
    { id: 'screen-11111111-1111-4111-8111-111111111111', width: 400, height: 300 },
  ])('accepts a supported PiP request', (opts) => {
    expect(isPipOpenOptions(opts)).toBe(true);
  });

  it.each([
    null,
    undefined,
    [],
    {},
    { id: '' },
    { id: 'x'.repeat(129) },
    { id: 'screen-../escape' },
    { id: 'screen-#x' },
    { id: 'ok', extra: true },
    { id: 'ok', width: -1 },
    { id: 'ok', width: 4097 },
    { id: 'ok', width: 1.5 },
    { id: 'ok', height: Infinity },
    { id: 'ok', height: '300' },
    { id: 'ok', title: 'x'.repeat(129) },
    { id: 'ok', title: 'bad\nname' },
  ])('rejects malformed or unbounded options', (opts) => {
    expect(isPipOpenOptions(opts)).toBe(false);
  });

  it('limits new windows per rolling interval and releases tokens as they age', () => {
    for (let time = 0; time < 8; time++) expect(consumePipOpenToken(time)).toBe(true);
    expect(consumePipOpenToken(8)).toBe(false);
    expect(consumePipOpenToken(3_000)).toBe(true);
  });
});
