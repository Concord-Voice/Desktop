// @vitest-environment node
// DoR §3.1 cross-language check, Node side: every committed vector verifies
// under the second implementation (precedent: stepUpPurpose.parity.test.ts).
// This file lives under scripts/ (private): a test under client/ that read
// scripts/ would ENOENT in the public mirror's frontend CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as gen from './gen.mjs';

type Vec = { name: string; type: string; bytes_b64?: string; input?: Record<string, any>; expect: Record<string, any> };

const file = JSON.parse(readFileSync(gen.VECTORS_PATH, 'utf8'));
const vectors: Vec[] = file.vectors;
const b = (s: string) => gen.b64d(s);
const ok = (v: Vec) => v.expect.reason === 'ok';

async function settles(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return true;
  } catch (e) {
    if (!(e instanceof gen.Malformed)) throw e;
    return false;
  }
}

const PRIM: Record<string, (v: Vec) => Promise<void>> = {
  'p384-point': async (v) => expect(await settles(gen.importP384(b(v.input!.point_b64)))).toBe(ok(v)),
  'p384-sig': async (v) =>
    expect(await gen.verifyP384(b(v.input!.point_b64), b(v.input!.msg_b64), b(v.input!.sig_b64))).toBe(ok(v)),
  'pss-sig': async (v) =>
    expect(await gen.verifyLegacyPSS(b(v.input!.spki_b64), b(v.input!.msg_b64), b(v.input!.sig_b64))).toBe(ok(v)),
  'ek-spki': async (v) => {
    expect(await settles(gen.checkEkSpkiWebCrypto(b(v.input!.spki_b64)))).toBe(ok(v));
    expect(await settles((async () => gen.checkEkSpkiTemplate(b(v.input!.spki_b64)))())).toBe(ok(v));
  },
  'device-id': async (v) => expect(await gen.deviceId(b(v.input!.dsk_b64))).toBe(v.expect.device_id),
  'safety-number': async (v) =>
    expect(await gen.safetyNumber(v.input!.account_id, b(v.input!.pin_digest_b64))).toBe(v.expect.safety_number),
  'age-claim-v2': async (v) => {
    const t = gen.ageClaimV2Bytes(v.input);
    expect(t ? gen.b64e(t) : null).toBe(ok(v) ? v.expect.text_b64 : null);
  },
  'session-bind-v1': async (v) => {
    const t = gen.sessionBindBytes(v.input);
    expect(t ? gen.b64e(t) : null).toBe(ok(v) ? v.expect.text_b64 : null);
  },
  'credential-epoch-digest': async (v) => {
    const d = await gen.credentialEpochDigest(v.input!.epoch, v.input!.epoch_valid);
    expect(d ? gen.b64e(d) : '').toBe(v.expect.digest_b64);
  },
  'population-digest': async (v) => {
    const recs = v.input!.records.map((r: any) => ({ account_id: r.account_id, legacy_ek_digest: b(r.legacy_ek_digest_b64) }));
    if (!ok(v)) return expect(await settles(gen.populationDigest(recs))).toBe(false);
    expect(gen.b64e(await gen.populationDigest(recs))).toBe(v.expect.digest_b64);
  },
  'tls-pin': async (v) => expect(gen.b64e(await gen.tlsPin(b(v.input!.point_b64)))).toBe(v.expect.digest_b64),
  'layout-fields': async (v) => {
    const fields = gen.LAYOUTS[v.input!.layout as string];
    expect(fields, `unknown layout ${v.input!.layout}`).toBeDefined();
    expect(fields.map(([name]: [string]) => name)).toEqual(v.input!.fields);
  },
  'device-head': async (v) => {
    const dh = b(v.bytes_b64!);
    const ch = b(v.input!.chain_head_b64);
    // The pairing check below is only about the digest. A negative must not pass
    // because the chain-head it travels with is itself broken.
    expect(await settles(gen.decode('chain-head', ch)), 'the paired chain-head decodes').toBe(true);
    let head: any;
    let paired = false;
    try {
      head = await gen.decode('device-head', dh);
      paired = gen.equalBytes(head.chain_head_digest, await gen.sha384(ch));
    } catch (e) {
      if (!(e instanceof gen.Malformed)) throw e;
    }
    expect(paired).toBe(ok(v));
    if (ok(v)) expect(gen.b64e(gen.encode('device-head', head))).toBe(v.expect.reencoded_b64);
  },
};

// A vector whose type has no PRIM handler is a layout vector. An unregistered type
// must fail here: decode() throws Malformed('unknown layout') for it, settles() reads
// that as a refusal, and a non-ok vector would then pass for the wrong reason.
async function layout(v: Vec) {
  expect(Object.hasOwn(gen.LAYOUTS, v.type), `${v.type}: no PRIM handler and no layout`).toBe(true);
  const bytes = b(v.bytes_b64!);
  if (!ok(v)) return expect(await settles(gen.decode(v.type, bytes))).toBe(false);
  const values = await gen.decode(v.type, bytes);
  expect(gen.b64e(gen.encode(v.type, values))).toBe(v.expect.reencoded_b64);
}

describe('authority vectors verify under the Node implementation', () => {
  it('were written by this gen.mjs (drift)', async () => {
    expect(file.generator_sha384).toBe(await gen.generatorDigest());
  });
  for (const v of vectors) {
    it(v.name, async () => {
      // Own keys only: PRIM[v.type] alone would resolve 'toString' or 'constructor'.
      await (Object.hasOwn(PRIM, v.type) ? PRIM[v.type] : layout)(v);
    }, 30_000);
  }
});
