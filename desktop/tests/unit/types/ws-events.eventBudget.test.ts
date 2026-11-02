/** Compatibility vectors from canonical Self-Hosted E / Hosted#2270 frozen contract.
 * Desktop uses its own in-tree schema; both exported and actual union parses must retain fields.
 */
import { describe, expect, it } from 'vitest';
import { ErrorSchema, WebSocketEventSchema } from '@/renderer/types/ws-events';

const classes = [
  'content',
  'typing',
  'subscription',
  'presence',
  'profile',
  'server',
  'ready',
  'renewal',
];
for (const [label, schema] of [
  ['ErrorSchema', ErrorSchema],
  ['actual union', WebSocketEventSchema],
] as const) {
  describe(`${label} advisory compatibility`, () => {
    it.each(classes)('retains class %s and exact retry after parsing', (event_class) => {
      const frame = {
        type: 'error',
        data: { code: 'ws_rate_limited', event_class, retry_after_ms: 5000 },
      };
      expect(schema.parse(frame)).toEqual(frame);
    });
    it.each([100, 1000, 5000, 30000])('retains producer retry %i', (retry_after_ms) => {
      const frame = {
        type: 'error',
        data: { code: 'ws_rate_limited', event_class: 'profile', retry_after_ms },
      };
      expect(schema.parse(frame)).toEqual(frame);
    });
    it('retains the actual producer JSON advisory example', () => {
      const frame: unknown = JSON.parse(
        '{"type":"error","data":{"code":"ws_rate_limited","event_class":"profile","retry_after_ms":5000}}'
      );
      expect(schema.parse(frame)).toEqual(frame);
    });
    it.each([99, 30001, 100.5, '1000', null, NaN, Infinity, -Infinity])(
      'rejects malformed delay %s',
      (retry_after_ms) => {
        expect(
          schema.safeParse({
            type: 'error',
            data: { code: 'ws_rate_limited', event_class: 'profile', retry_after_ms },
          }).success
        ).toBe(false);
      }
    );
    it.each(['unknown', 'Profile', 'profile ', ' profile', ''])(
      'rejects unknown class %j',
      (event_class) => {
        expect(
          schema.safeParse({
            type: 'error',
            data: { code: 'ws_rate_limited', event_class, retry_after_ms: 1000 },
          }).success
        ).toBe(false);
      }
    );
    it.each([
      { code: 'ws_rate_limited' },
      { code: 'ws_rate_limited', event_class: 'profile' },
      { code: 'ws_rate_limited', retry_after_ms: 1000 },
      { event_class: 'profile' },
      { retry_after_ms: 1000 },
      { code: 'other', event_class: 'profile' },
      { code: 'other', retry_after_ms: 1000 },
    ])('rejects missing or partial pair %j', (data) => {
      expect(schema.safeParse({ type: 'error', data }).success).toBe(false);
    });
    it.each([undefined, 'other'])(
      'accepts complete pairs with unrelated/absent code %s',
      (code) => {
        const frame = {
          type: 'error',
          data: { ...(code ? { code } : {}), event_class: 'profile', retry_after_ms: 1000 },
        };
        expect(schema.parse(frame)).toEqual(frame);
      }
    );
    it('preserves legacy epoch errors, empty data and unknown-field stripping', () => {
      for (const data of [
        {},
        {
          code: 'epoch_revoked',
          channel_id: '33333333-3333-4333-8333-333333333333',
          current_epoch: 3,
        },
      ]) {
        expect(schema.parse({ type: 'error', data })).toEqual({ type: 'error', data });
      }
      expect(
        schema.parse({ type: 'error', data: { code: 'other', unknown: 'not strict' } })
      ).toEqual({ type: 'error', data: { code: 'other' } });
    });
  });
}
