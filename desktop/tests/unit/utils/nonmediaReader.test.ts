// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encodeNonmediaContext,
  parseNonmediaContext,
  type NonmediaContext,
} from '../../../src/renderer/utils/crypto/nonmediaContext';
import {
  channelKeyCapsuleLabel,
  openNonmediaTextEnvelope,
  type NonmediaTextFormat,
} from '../../../src/renderer/utils/crypto/nonmediaEnvelope';

const corpusBytes = readFileSync(
  new URL('../../fixtures/nonmedia-e2ee-v1-vectors.json', import.meta.url)
);
const corpusPin =
  '4a16bb107203d840152ce432bcbeda286c7ecb79b2b519713eebb2d3701589433f54fad511d0e52b439ea230d49833e2';

if (createHash('sha384').update(corpusBytes).digest('hex') !== corpusPin)
  throw new Error('ADR-0051 corpus SHA-384 mismatch before parse');

type Vector = {
  name: string;
  input: Record<string, string>;
  expect: { verdict: string; outputs?: Record<string, string> };
};

const vectors = (JSON.parse(corpusBytes.toString('utf8')) as { vectors: Vector[] }).vectors;
const vector = (name: string): Vector => {
  const item = vectors.find((entry) => entry.name === name);
  if (!item) throw new Error(`missing corpus vector: ${name}`);
  return item;
};
const base64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));
const base64Text = (text: string): string => Buffer.from(text, 'base64').toString('ascii');

describe('dormant ADR-0051 reader', () => {
  it.each([
    ['message-v1', 'm1'],
    ['blob-v1', 'b1'],
    ['account-ek-wrap-v1', 'ek1'],
    ['recovery-wrap-v1', 'rw1-private'],
    ['recovery-prefs-wrap-v1', 'rw1-preferences'],
  ] as const)(
    'opens the pinned %s ciphertext only under its expected context',
    async (tag, format) => {
      const sample = vector(`aead/decrypt/${tag}/base`);
      const expected = parseNonmediaContext(base64(sample.input.expected_context_b64));
      expect(expected.tag).toBe(tag);
      const key = await webcrypto.subtle.importKey(
        'raw',
        base64(sample.input.key_b64),
        'AES-GCM',
        false,
        ['decrypt']
      );
      const envelope = base64Text(sample.input.envelope_b64);
      const plaintext = await openNonmediaTextEnvelope(format, envelope, key, expected as never);
      expect(Buffer.from(plaintext)).toEqual(
        Buffer.from(sample.expect.outputs?.plaintext_b64 ?? '', 'base64')
      );

      const altered = { ...expected, fields: [...expected.fields] } as NonmediaContext;
      (altered.fields as unknown[])[0] = '22222222-2222-4222-8222-222222222222';
      await expect(
        openNonmediaTextEnvelope(format, envelope, key, altered as never)
      ).rejects.toThrow();
      await expect(
        openNonmediaTextEnvelope(
          format,
          envelope.replace(/^[^:]+:/, 'wrong:'),
          key,
          expected as never
        )
      ).rejects.toThrow();
    }
  );

  it('does not choose the other recovery context for the shared rw1 prefix', async () => {
    const sample = vector('aead/decrypt/recovery-wrap-v1/base');
    const privateContext = parseNonmediaContext(base64(sample.input.expected_context_b64));
    const preferences = vector('aead/decrypt/recovery-prefs-wrap-v1/base');
    const preferencesContext = parseNonmediaContext(base64(preferences.input.expected_context_b64));
    const key = await webcrypto.subtle.importKey(
      'raw',
      base64(sample.input.key_b64),
      'AES-GCM',
      false,
      ['decrypt']
    );

    await expect(
      openNonmediaTextEnvelope(
        'rw1-preferences',
        base64Text(sample.input.envelope_b64),
        key,
        preferencesContext as never
      )
    ).rejects.toThrow();
    await expect(
      openNonmediaTextEnvelope(
        'rw1-private',
        base64Text(sample.input.envelope_b64),
        key,
        privateContext as never
      )
    ).resolves.toBeDefined();
  });

  it('rejects noncanonical or unregistered context before use', () => {
    const sample = vector('aead/decrypt/message-v1/base');
    const canonical = base64(sample.input.expected_context_b64);
    const context = parseNonmediaContext(canonical);
    expect(encodeNonmediaContext(context)).toEqual(canonical);
    expect(() =>
      parseNonmediaContext(
        new TextEncoder().encode(new TextDecoder().decode(canonical).replace(',1,', ', 1,'))
      )
    ).toThrow();
    expect(() => encodeNonmediaContext({ ...context, tag: 'unregistered' } as never)).toThrow();
  });

  it('rejects every pinned malformed or invalid context parse case', () => {
    const rejected = vectors.filter(
      (entry) => entry.name.startsWith('context/parse/') && entry.expect.verdict === 'reject'
    );
    expect(rejected.length).toBeGreaterThanOrEqual(8);
    for (const entry of rejected) {
      expect(() => parseNonmediaContext(base64(entry.input.context_b64)), entry.name).toThrow();
    }
  });

  it('parses every pinned accepted context without changing its bytes', () => {
    const accepted = vectors.filter(
      (entry) => entry.name.startsWith('context/encode/') && entry.expect.verdict === 'accept'
    );
    expect(accepted.length).toBeGreaterThanOrEqual(7);
    for (const entry of accepted) {
      const source = base64(entry.expect.outputs?.context_b64 ?? '');
      expect(encodeNonmediaContext(parseNonmediaContext(source)), entry.name).toEqual(source);
    }
  });

  it('derives the capsule label from validated context bytes', () => {
    const sample = vector('rsa-label/derive/channel-key-capsule-v1/base');
    const context = {
      tag: 'channel-key-capsule-v1',
      fields: sample.input.context_fields,
    } as unknown as Extract<NonmediaContext, { tag: 'channel-key-capsule-v1' }>;
    expect(channelKeyCapsuleLabel(context)).toEqual(base64(sample.expect.outputs?.label_b64 ?? ''));
  });
});
