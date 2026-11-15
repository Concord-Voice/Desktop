import { beforeEach, describe, expect, it } from 'vitest';
import {
  _pipOpenBudgetHeldForTesting,
  _resetPipOpenBudgetForTesting,
  consumePipOpenToken,
  isPipId,
  isPipOpenOptions,
  MAX_PIP_WINDOWS,
  MAX_PIP_WINDOWS_PER_CONNECTION,
  releasePipOpenBudget,
} from '@/main/pipOpenPolicy';
import type { ConnectionId } from '@/shared/connectionIdentity';

const A = 'connection-a' as ConnectionId;
const B = 'connection-b' as ConnectionId;

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
    for (let time = 0; time < 8; time++) expect(consumePipOpenToken(A, time)).toBe(true);
    expect(consumePipOpenToken(A, 8)).toBe(false);
    expect(consumePipOpenToken(A, 3_000)).toBe(true);
  });

  // #86 RT5: one connection's opens never spend another's tokens.
  it('keeps one rolling window per connection', () => {
    for (let time = 0; time < 8; time++) expect(consumePipOpenToken(A, time)).toBe(true);
    expect(consumePipOpenToken(A, 8)).toBe(false);
    expect(consumePipOpenToken(B, 8)).toBe(true);
  });

  it('drops a released connection and leaves the others alone', () => {
    for (let time = 0; time < 8; time++) consumePipOpenToken(A, time);
    consumePipOpenToken(B, 0);
    releasePipOpenBudget(A);
    expect(_pipOpenBudgetHeldForTesting(A)).toBe(false);
    expect(_pipOpenBudgetHeldForTesting(B)).toBe(true);
  });

  it('caps one connection at half the process-wide ceiling', () => {
    expect(MAX_PIP_WINDOWS_PER_CONNECTION * 2).toBe(MAX_PIP_WINDOWS);
  });

  // #86 RT4: main keys PiPs `<connectionId>:<id>`, which is unambiguous only while an id
  // cannot contain ':'.
  it.each(['controls-main', 'screen-11111111-1111-4111-8111-111111111111', 'a', 'x'.repeat(128)])(
    'accepts the PiP id %s',
    (id) => expect(isPipId(id)).toBe(true)
  );

  it.each(['', 'a:b', 'connection-a:controls-main', 'x'.repeat(129), 'a/b', 42, null])(
    'refuses the PiP id %s',
    (id) => expect(isPipId(id)).toBe(false)
  );
});
