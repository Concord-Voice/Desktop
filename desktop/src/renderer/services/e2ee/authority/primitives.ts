// §2.4 primitives and the frozen canonical texts of the account-key authority
// contract (design of record §2.4, §2.19, §2.20). A port of Concord-Voice/Self-Hosted
// scripts/authority-vectors/gen.mjs §3; the committed vectors decide every byte.

import { b64d, buf, cmp, concat, equalBytes, fromHex, toHex, utf8 } from './bytes';
import { Malformed } from './errors';

const { subtle } = globalThis.crypto;

export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUUID = (s: string): boolean => UUID_RE.test(s);
export const isUUIDv4 = (s: string): boolean =>
  isUUID(s) && s[14] === '4' && '89ab'.includes(s[19]);

export function parseU(s: string): number {
  if (!/^(0|[1-9]\d*)$/.test(s) || s.length > 16 || BigInt(s) > BigInt(MAX_SAFE))
    throw new Malformed('u');
  return Number(s);
}

// P-384 over y² = x³ − 3x + b. The codec checks the curve itself so a point is
// refused the same way in every runtime, before any importKey.
const P384_P = 2n ** 384n - 2n ** 128n - 2n ** 96n + 2n ** 32n - 1n;
const P384_B =
  0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn;
const big = (b: Uint8Array): bigint => BigInt('0x' + toHex(b));
const modp = (a: bigint): bigint => ((a % P384_P) + P384_P) % P384_P;

export function checkPoint(b: Uint8Array): void {
  if (b.length !== 97 || b[0] !== 0x04) throw new Malformed('point form');
  const x = big(b.subarray(1, 49));
  const y = big(b.subarray(49));
  if (x >= P384_P || y >= P384_P) throw new Malformed('point range');
  if (modp(y * y) !== modp(x * x * x - 3n * x + P384_B)) throw new Malformed('point not on curve');
}

// The canonical 550-byte SPKI of an RSA-4096 key with e = 65537: a fixed
// 33-byte header and 5-byte trailer around a 512-byte modulus with its top bit set.
const EK_HDR = fromHex('30820222300d06092a864886f70d01010105000382020f003082020a0282020100');
const EK_TRL = fromHex('0203010001');

export function checkEkSpkiTemplate(b: Uint8Array): void {
  if (
    b.length !== 550 ||
    !equalBytes(b.subarray(0, 33), EK_HDR) ||
    !equalBytes(b.subarray(545), EK_TRL) ||
    (b[33] & 0x80) === 0
  ) {
    throw new Malformed('ek spki');
  }
}

/** The design of record's Web Crypto procedure for an encryption-key SPKI (§2.4). */
export async function checkEkSpkiWebCrypto(b: Uint8Array): Promise<void> {
  if (b.length !== 550) throw new Malformed('ek spki length');
  let key: CryptoKey;
  try {
    key = await subtle.importKey('spki', buf(b), { name: 'RSA-OAEP', hash: 'SHA-256' }, true, [
      'encrypt',
    ]);
  } catch {
    throw new Malformed('ek spki parse');
  }
  const alg = key.algorithm as RsaHashedKeyAlgorithm;
  if (alg.modulusLength !== 4096) throw new Malformed('ek modulus');
  if (!equalBytes(alg.publicExponent, new Uint8Array([1, 0, 1])))
    throw new Malformed('ek exponent');
  if (!equalBytes(new Uint8Array(await subtle.exportKey('spki', key)), b)) {
    throw new Malformed('ek spki not canonical');
  }
}

export const sha384 = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await subtle.digest('SHA-384', buf(b)));

/** Checks length and the 0x04 prefix BEFORE importKey: some runtimes accept 0x06/0x07 hybrid points. */
export async function importP384(b: Uint8Array): Promise<CryptoKey> {
  if (b.length !== 97 || b[0] !== 0x04) throw new Malformed('point_prefix');
  try {
    return await subtle.importKey('raw', buf(b), { name: 'ECDSA', namedCurve: 'P-384' }, true, [
      'verify',
    ]);
  } catch {
    throw new Malformed('point');
  }
}

/** ECDSA P-384 / SHA-384 over `msg`, P1363 `r‖s` (96 bytes). Never throws. */
export async function verifyP384(
  point: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array
): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await importP384(point);
  } catch {
    return false;
  }
  if (sig.length !== 96) return false;
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, key, buf(sig), buf(msg));
}

/** Legacy RSA-PSS (SHA-256, salt 32) against a canonical EK SPKI. Never throws. */
export async function verifyLegacyPSS(
  spki: Uint8Array,
  msg: Uint8Array,
  sig: Uint8Array
): Promise<boolean> {
  try {
    await checkEkSpkiWebCrypto(spki);
  } catch {
    return false;
  }
  if (sig.length !== 512) return false;
  try {
    const key = await subtle.importKey(
      'spki',
      buf(spki),
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['verify']
    );
    return await subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, key, buf(sig), buf(msg));
  } catch {
    return false;
  }
}

/** §2.19 DeviceID: a v4-shaped UUID from SHA-384("concord-device-id/v1" ‖ 0 ‖ dsk). */
export async function deviceId(dsk: Uint8Array): Promise<string> {
  const b = (await sha384(concat(utf8('concord-device-id/v1'), [0], dsk))).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = toHex(b);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** The synchronous shape of a `dev` record: `id.dsk.dkx.mature_at_ms`. */
export function checkDevShape(s: string): void {
  const p = s.split('.');
  if (p.length !== 4 || !isUUIDv4(p[0])) throw new Malformed('dev');
  checkPoint(b64d(p[1]));
  checkPoint(b64d(p[2]));
  parseU(p[3]);
}

export interface DevRecord {
  id: string;
  dsk: Uint8Array;
  dkx: Uint8Array;
  matureAtMs: number;
}

export async function parseDev(s: string): Promise<DevRecord> {
  checkDevShape(s);
  if (s.length > 319) throw new Malformed('dev length');
  const [id, dskB64, dkxB64, mature] = s.split('.');
  const dsk = b64d(dskB64);
  if ((await deviceId(dsk)) !== id) throw new Malformed('dev id is not DeviceID(dsk)');
  return { id, dsk, dkx: b64d(dkxB64), matureAtMs: parseU(mature) };
}

/**
 * LD-28 safety number: 12 groups of 5 digits, or '' for an invalid input (vector
 * parity). A caller that displays it must treat '' as an error, never show it.
 */
export async function safetyNumber(accountId: string, pinDigest: Uint8Array): Promise<string> {
  if (!isUUID(accountId) || pinDigest.length !== 48) return '';
  const h = new Uint8Array(
    await subtle.digest(
      'SHA-512',
      buf(concat(utf8('concord-safety-number/v1'), [0], utf8(accountId), pinDigest))
    )
  );
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    let v = 0;
    for (const c of h.subarray(5 * i, 5 * i + 5)) v = v * 256 + c;
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

const HEX64 = /^[0-9a-f]{64}$/;
const CLIENT_V = /^[0-9A-Za-z.+-]{1,32}$/;

export interface AgeClaimV2 {
  user_id: string;
  valid_age: boolean;
  nsfw_auth: boolean;
  jurisdiction_obligation: number;
  nonce: string;
  timestamp: number;
  device_id: string;
  client_version: string;
}

/** The frozen `age-claim/v2` text (§2.20), or null when any field is out of form. */
export function ageClaimV2Bytes(c: AgeClaimV2): Uint8Array | null {
  if (
    typeof c.valid_age !== 'boolean' ||
    typeof c.nsfw_auth !== 'boolean' ||
    !isUUID(c.user_id) ||
    !isUUIDv4(c.device_id) ||
    !HEX64.test(c.nonce) ||
    !CLIENT_V.test(c.client_version) ||
    !Number.isInteger(c.jurisdiction_obligation) ||
    c.jurisdiction_obligation < 0 ||
    c.jurisdiction_obligation > 2 ||
    !Number.isSafeInteger(c.timestamp) ||
    c.timestamp <= 0
  ) {
    return null;
  }
  return utf8(
    `age-claim/v2\ncanonical_version=2\nuser_id=${c.user_id}\nvalid_age=${c.valid_age}\n` +
      `nsfw_auth=${c.nsfw_auth}\njurisdiction_obligation=${c.jurisdiction_obligation}\nnonce=${c.nonce}\n` +
      `timestamp=${c.timestamp}\ndevice_id=${c.device_id}\nclient_version=${c.client_version}`
  );
}

export interface SessionBind {
  realm_id: string;
  user_id: string;
  device_id: string;
  session_id: string;
  challenge: string;
  issued_at_ms: number;
}

/** The frozen `concord-session-bind/v1` text (§2.19), or null when any field is out of form. */
export function sessionBindBytes(b: SessionBind): Uint8Array | null {
  if (
    ![b.realm_id, b.user_id, b.session_id].every(isUUID) ||
    !isUUIDv4(b.device_id) ||
    !HEX64.test(b.challenge) ||
    !Number.isSafeInteger(b.issued_at_ms) ||
    b.issued_at_ms <= 0
  ) {
    return null;
  }
  return utf8(
    `concord-session-bind/v1\nrealm_id=${b.realm_id}\nuser_id=${b.user_id}\ndevice_id=${b.device_id}\n` +
      `session_id=${b.session_id}\nchallenge=${b.challenge}\nissued_at_ms=${b.issued_at_ms}`
  );
}

/** SHA-384 of a valid, non-empty credential epoch; null for an invalid one (pass null) or ''. */
export async function credentialEpochDigest(epoch: string | null): Promise<Uint8Array | null> {
  return epoch === null || epoch === '' ? null : sha384(utf8(epoch));
}

export interface PopulationRecord {
  account_id: string;
  legacy_ek_digest: Uint8Array;
}

export async function populationDigest(records: PopulationRecord[]): Promise<Uint8Array> {
  const sorted = [...records].sort((a, b) => cmp(a.account_id, b.account_id));
  for (let i = 0; i < sorted.length; i++) {
    if (!isUUID(sorted[i].account_id) || sorted[i].legacy_ek_digest.length !== 48) {
      throw new Malformed('population record');
    }
    if (i > 0 && sorted[i - 1].account_id === sorted[i].account_id)
      throw new Malformed('duplicate account');
  }
  return sha384(concat(...sorted.flatMap((r) => [utf8(r.account_id), r.legacy_ek_digest])));
}

/** A TLS pin is SHA-384 over the point's SPKI encoding (§2.4, LD-19). */
export async function tlsPin(point: Uint8Array): Promise<Uint8Array> {
  const key = await importP384(point);
  return sha384(new Uint8Array(await subtle.exportKey('spki', key)));
}
