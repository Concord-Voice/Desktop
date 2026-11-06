// Opening a device wrap (design of record §2.5 `device-wrap` and
// `device-secrets` checks 1–4, D-244). A port of the open half of
// Concord-Voice/Self-Hosted services/control-plane/internal/authoritycontract/wrap.go.
//
// Mechanism: Z = ECDH P-384 (self's dkx, epk), its 48-byte x-coordinate;
// K = HKDF-SHA-384(Z, salt device_entry_digest, info, 32), held only as a
// non-extractable CryptoKey; AES-256-GCM under the wrap's 12-byte nonce and the
// 265-byte AAD.
//
// Key-material hygiene: the byte arrays this file holds (Z, the plaintext, the
// decoded keys of a refused wrap, every copy handed to importKey or returned by
// exportKey, the probe and its decryption) are zeroed before the function that
// holds them returns. CryptoKey internals are out of reach. The accepted
// secrets are the caller's to zero. No Reason carries key material.

import { b64d, buf, concat, equalBytes, utf8 } from './bytes';
import type { DeviceHead } from './heads';
import { decodeAs, type DeviceSecrets, type DeviceWrap } from './messages';
import { checkEkSpkiTemplate, verifyP384 } from './primitives';
import type { Reason } from './reason';

const { subtle } = globalThis.crypto;

/** "concord-device-wrap/v1" ‖ 0x00: HKDF's info prefix. */
const WRAP_INFO = utf8('concord-device-wrap/v1\0');
/** "concord-device-secrets-check/v1" ‖ 0x00: check 3's signed prefix. */
const ROOT_CHECK = utf8('concord-device-secrets-check/v1\0');
const ENTRY_LEN = 48;
const PROBE_LEN = 32;
const SECRETS_OPS = ['add_device', 'rotate_ek', 'rotate_root'];

/** Check 4: the wrap names self's latest secrets entry (current) or an earlier one (history). */
export type WrapUse = 'current' | 'history';

/** What verifyDeviceWrap returns: the secrets and their use, or null and wrap_invalid. */
export interface WrapOpened {
  secrets: DeviceSecrets | null;
  use: WrapUse | null;
  reason: Reason;
}

/** Self's dkx: an ECDH P-384 key pair (the shape of Web Crypto's CryptoKeyPair). */
export interface DkxPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

type Usage = 'sign' | 'decrypt' | 'deriveKey';
type ImportAlg = string | { name: string; namedCurve?: string; hash?: string };

const REFUSED: WrapOpened = Object.freeze({ secrets: null, use: null, reason: 'wrap_invalid' });

/** One of self's secrets entries (device-head #10): its op, effective root (none for rotate_ek) and EK SPKI. */
interface SecretsEntry {
  op: string;
  root: Uint8Array;
  spki: Uint8Array;
  latest: boolean;
}

/** Check 2's rule: root_pkcs8 is present iff op ∈ {add_device, rotate_root}. */
const carriesRoot = (op: string): boolean => op === 'add_device' || op === 'rotate_root';

const b64 = (s: string): Uint8Array | null => {
  try {
    return b64d(s);
  } catch {
    return null;
  }
};

/** `<entry b64>.<op>.<root point b64, or empty>.<EK SPKI b64>`; null when it does not read. */
function parseSecretsRecord(rec: string): [Uint8Array, SecretsEntry] | null {
  const p = rec.split('.');
  if (p.length !== 4 || !SECRETS_OPS.includes(p[1]) || (p[2] !== '') !== carriesRoot(p[1]))
    return null;
  const entry = b64(p[0]);
  const root = p[2] === '' ? new Uint8Array(0) : b64(p[2]);
  const spki = b64(p[3]);
  if (entry?.length !== ENTRY_LEN || !root || !spki) return null;
  return [entry, { op: p[1], root, spki, latest: false }];
}

/**
 * Check 1's lookup: the record naming entry among self's secrets entries. It
 * fails closed on a head it cannot read unambiguously: a record that does not
 * parse, or an entry named twice, names no entry.
 */
function secretsEntry(h: DeviceHead, entry: Uint8Array): SecretsEntry | null {
  let found: SecretsEntry | null = null;
  let n = 0;
  for (let i = 0; i < h.secrets.length; i++) {
    const r = parseSecretsRecord(h.secrets[i]);
    if (!r) return null;
    if (equalBytes(r[0], entry)) {
      found = { ...r[1], latest: i === h.secrets.length - 1 };
      n++;
    }
  }
  return n === 1 ? found : null;
}

/** A compare whose time does not depend on where two secrets first differ. */
function sameSecret(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** importKey over a zeroed-after copy of key material. */
async function importSecret(
  format: 'pkcs8' | 'raw',
  b: Uint8Array,
  alg: ImportAlg,
  extractable: boolean,
  usages: Usage[]
): Promise<CryptoKey> {
  const copy = b.slice();
  try {
    return await subtle.importKey(format, copy, alg, extractable, usages);
  } finally {
    copy.fill(0);
  }
}

/**
 * A PKCS#8 accepted only as its key's canonical encoding: Web Crypto's export
 * of the imported key must equal the input byte for byte. That refuses a lying
 * optional publicKey field, inner curve parameters and trailing bytes, which
 * an implementation might otherwise ignore (NEW-1, wrap/pkcs8-*).
 */
async function importCanonical(
  der: Uint8Array,
  alg: ImportAlg,
  usages: Usage[]
): Promise<CryptoKey | null> {
  try {
    const k = await importSecret('pkcs8', der, alg, true, usages);
    const re = new Uint8Array(await subtle.exportKey('pkcs8', k));
    const same = sameSecret(re, der);
    re.fill(0);
    return same ? k : null;
  } catch {
    return null;
  }
}

/**
 * Check 3's root half: the imported P-384 scalar signs ROOT_CHECK ‖ entry and
 * the signature verifies under the entry's effective active root. PKCS#8's
 * optional publicKey field plays no part.
 */
async function rootCorresponds(
  der: Uint8Array,
  root: Uint8Array,
  entry: Uint8Array
): Promise<boolean> {
  const k = await importCanonical(der, { name: 'ECDSA', namedCurve: 'P-384' }, ['sign']);
  if (!k) return false;
  const msg = concat(ROOT_CHECK, entry);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, k, buf(msg)));
  return verifyP384(root, msg, sig);
}

/**
 * Check 3's EK half: a fresh 32-byte value RSA-OAEP-encrypted (SHA-256, empty
 * label) under the expected SPKI decrypts to itself under the imported EK.
 */
async function ekCorresponds(der: Uint8Array, spki: Uint8Array): Promise<boolean> {
  const alg = { name: 'RSA-OAEP', hash: 'SHA-256' };
  let pub: CryptoKey;
  try {
    checkEkSpkiTemplate(spki);
    pub = await subtle.importKey('spki', spki.slice(), alg, false, ['encrypt']);
  } catch {
    return false;
  }
  const priv = await importCanonical(der, alg, ['decrypt']);
  if (!priv) return false;
  const probe = globalThis.crypto.getRandomValues(new Uint8Array(PROBE_LEN));
  let got = new Uint8Array(0);
  try {
    const ct = await subtle.encrypt({ name: 'RSA-OAEP' }, pub, probe);
    got = new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP' }, priv, ct));
    return sameSecret(got, probe);
  } catch {
    return false;
  } finally {
    probe.fill(0);
    got.fill(0);
  }
}

/** Checks 2 and 3: the root is proven only for an entry that carries one. */
async function secretsAccepted(
  e: SecretsEntry,
  s: DeviceSecrets,
  entry: Uint8Array
): Promise<boolean> {
  const wantRoot = carriesRoot(e.op);
  if (s.root_pkcs8.length > 0 !== wantRoot || s.ek_pkcs8.length === 0) return false; // check 2
  if (wantRoot && !(await rootCorresponds(s.root_pkcs8, e.root, entry))) return false;
  return ekCorresponds(s.ek_pkcs8, e.spki);
}

/** Z = ECDH(dkx, epk), K by HKDF-SHA-384, then AES-256-GCM open under the 265-byte AAD; null on any failure. */
async function decryptWrap(w: DeviceWrap, dkx: DkxPair): Promise<Uint8Array | null> {
  let z = new Uint8Array(0);
  try {
    const curve = { name: 'ECDH', namedCurve: 'P-384' };
    const epk = await subtle.importKey('raw', buf(w.epk), curve, false, []);
    z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: epk }, dkx.privateKey, 384));
    const dkxPub = new Uint8Array(await subtle.exportKey('raw', dkx.publicKey));
    const ids = [w.realm_id, w.account_id, w.recipient_device_id].map(utf8);
    const info = concat(WRAP_INFO, ...ids, w.epk, dkxPub);
    const hk = await importSecret('raw', z, 'HKDF', false, ['deriveKey']);
    const k = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-384', salt: buf(w.device_entry_digest), info: buf(info) },
      hk,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const aad = concat(...ids, w.device_entry_digest, w.epk, w.nonce);
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: buf(w.nonce), additionalData: buf(aad), tagLength: 128 },
      k,
      buf(w.ct)
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  } finally {
    z.fill(0);
  }
}

async function openWrap(h: DeviceHead, w: DeviceWrap, dkx: DkxPair): Promise<WrapOpened> {
  // Check 1: this head's account, addressed to self, under one of self's secrets
  // entries. The CP monitor's self is "", which no decoded wrap names.
  if (
    w.realm_id !== h.realm_id ||
    w.account_id !== h.account_id ||
    w.recipient_device_id !== h.self_device_id
  )
    return REFUSED;
  const e = secretsEntry(h, w.device_entry_digest);
  if (!e) return REFUSED;
  const pt = await decryptWrap(w, dkx);
  if (!pt) return REFUSED;
  const s = await decodeAs('device-secrets', pt);
  pt.fill(0);
  if (!s) return REFUSED;
  if (!(await secretsAccepted(e, s, w.device_entry_digest))) {
    s.root_pkcs8.fill(0);
    s.ek_pkcs8.fill(0);
    return REFUSED;
  }
  return { secrets: s, use: e.latest ? 'current' : 'history', reason: 'ok' }; // check 4
}

/**
 * Opens wrap with self's dkx (an ECDH P-384 key pair) and accepts its
 * device-secrets only under §2.5's checks 1–4 (D-244). h must be the
 * DeviceHead verifyDeviceLedger returned. Every failure is wrap_invalid with no
 * secrets and no use: the Reason does not say which check refused. Never throws.
 */
export async function verifyDeviceWrap(
  h: DeviceHead,
  wrap: Uint8Array,
  dkx: DkxPair
): Promise<WrapOpened> {
  try {
    const w = await decodeAs('device-wrap', wrap); // EN5; the epk position is a §2.4 point
    return w ? await openWrap(h, w, dkx) : REFUSED;
  } catch {
    return REFUSED;
  }
}
