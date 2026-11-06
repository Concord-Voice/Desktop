// Sealing and opening a device wrap (design of record §2.5 `device-wrap` and
// `device-secrets` checks 1–4, D-244). A port of
// Concord-Voice/Self-Hosted services/control-plane/internal/authoritycontract/wrap.go.
//
// Mechanism: Z = ECDH P-384 (self's dkx, epk), its 48-byte x-coordinate;
// K = HKDF-SHA-384(Z, salt device_entry_digest, info, 32), held only as a
// non-extractable CryptoKey; AES-256-GCM under the wrap's 12-byte nonce and the
// 265-byte AAD.
//
// Key-material hygiene, best effort: the byte arrays this file holds (Z, the
// plaintext, the decoded keys of a refused wrap, every copy handed to importKey
// or returned by exportKey, the probe and its decryption) are zeroed before the
// function that holds them returns, on every path. JavaScript cannot zero
// everything: strings and intermediate buffers inside the codec, and the
// internals of every CryptoKey (including the extractable ones the canonical
// PKCS#8 check imports), stay until the garbage collector frees them. The
// accepted secrets are the caller's to zero. No Reason carries key material.

import { b64d, buf, concat, equalBytes, utf8 } from './bytes';
import type { DeviceHead } from './heads';
import { activeRecipient } from './ledger';
import { decodeAs, encodeAs, type DeviceSecrets, type DeviceWrap } from './messages';
import { checkEkSpkiTemplate, verifyP384, type DevRecord } from './primitives';
import type { Reason } from './reason';

const { subtle } = globalThis.crypto;

/** "concord-device-wrap/v1" ‖ 0x00: HKDF's info prefix. */
const WRAP_INFO = utf8('concord-device-wrap/v1\0');
/** "concord-device-secrets-check/v1" ‖ 0x00: check 3's signed prefix. */
const ROOT_CHECK = utf8('concord-device-secrets-check/v1\0');
const ENTRY_LEN = 48;
const NONCE_LEN = 12;
const PROBE_LEN = 32;
const P384_ECDH = { name: 'ECDH', namedCurve: 'P-384' };
const SECRETS_OPS = new Set(['add_device', 'rotate_ek', 'rotate_root']);

/** Check 4: the wrap names self's latest secrets entry (current) or an earlier one (history). */
export type WrapUse = 'current' | 'history';

/** What verifyDeviceWrap returns: the secrets and their use, or null and wrap_invalid. */
export interface WrapOpened {
  secrets: DeviceSecrets | null;
  use: WrapUse | null;
  reason: Reason;
}

/**
 * Self's dkx: an ECDH P-384 key pair (the shape of Web Crypto's CryptoKeyPair),
 * generated together. publicKey must be the private key's own public half and
 * extractable (its raw point is in HKDF's info); a mismatched one only makes
 * every wrap wrap_invalid. privateKey should be non-extractable with the
 * deriveBits usage only.
 */
export interface DkxPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

type Usage = 'sign' | 'decrypt' | 'encrypt' | 'deriveKey';
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
  if (p.length !== 4 || !SECRETS_OPS.has(p[1]) || (p[2] !== '') !== carriesRoot(p[1])) return null;
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

/** The wrap's ids, its HKDF info half and its AAD, all byte-exact to §2.5. */
interface WrapFrame {
  realm_id: string;
  account_id: string;
  recipient_device_id: string;
  device_entry_digest: Uint8Array;
  epk: Uint8Array;
  nonce: Uint8Array;
}

const idsOf = (w: WrapFrame): Uint8Array[] =>
  [w.realm_id, w.account_id, w.recipient_device_id].map(utf8);

const aadOf = (w: WrapFrame): Uint8Array =>
  concat(...idsOf(w), w.device_entry_digest, w.epk, w.nonce);

/** K = HKDF-SHA-384(Z, salt entry digest, info ‖ ids ‖ epk ‖ recipient dkx, 32) as a non-extractable AES-256-GCM key. */
async function wrapAesKey(
  z: Uint8Array,
  w: WrapFrame,
  dkxPub: Uint8Array,
  usage: Usage
): Promise<CryptoKey> {
  const info = concat(WRAP_INFO, ...idsOf(w), w.epk, dkxPub);
  const hk = await importSecret('raw', z, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-384', salt: buf(w.device_entry_digest), info: buf(info) },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

const gcm = (w: WrapFrame) => ({
  name: 'AES-GCM',
  iv: buf(w.nonce),
  additionalData: buf(aadOf(w)),
  tagLength: 128,
});

/** Z = ECDH(dkx, epk), K by HKDF-SHA-384, then AES-256-GCM open under the 265-byte AAD; null on any failure. */
async function decryptWrap(w: DeviceWrap, dkx: DkxPair): Promise<Uint8Array | null> {
  let z = new Uint8Array(0);
  try {
    const epk = await subtle.importKey('raw', buf(w.epk), P384_ECDH, false, []);
    z = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: epk }, dkx.privateKey, 384));
    const dkxPub = new Uint8Array(await subtle.exportKey('raw', dkx.publicKey));
    const k = await wrapAesKey(z, w, dkxPub, 'decrypt');
    return new Uint8Array(await subtle.decrypt(gcm(w), k, buf(w.ct)));
  } catch {
    return null;
  } finally {
    z.fill(0);
  }
}

/** A fresh ephemeral key, Z its x-coordinate with the recipient's dkx, a fresh nonce, then AES-256-GCM. */
async function encryptWrap(
  h: Pick<DeviceHead, 'realm_id' | 'account_id'>,
  r: DevRecord,
  entry: Uint8Array,
  pt: Uint8Array
): Promise<Uint8Array | null> {
  let z = new Uint8Array(0);
  const ptb = buf(pt); // Web Crypto's own copy of the plaintext, zeroed below
  try {
    const peer = await subtle.importKey('raw', buf(r.dkx), P384_ECDH, false, []);
    const eph = (await subtle.generateKey(P384_ECDH, false, ['deriveBits'])) as DkxPair;
    z = new Uint8Array(
      await subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 384)
    );
    const frame: WrapFrame = {
      realm_id: h.realm_id,
      account_id: h.account_id,
      recipient_device_id: r.id,
      device_entry_digest: entry,
      epk: new Uint8Array(await subtle.exportKey('raw', eph.publicKey)),
      nonce: globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LEN)),
    };
    const k = await wrapAesKey(z, frame, r.dkx, 'encrypt');
    const ct = new Uint8Array(await subtle.encrypt(gcm(frame), k, ptb));
    return encodeAs('device-wrap', { ...frame, ct });
  } finally {
    z.fill(0);
    new Uint8Array(ptb).fill(0);
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
  let s: DeviceSecrets | null;
  try {
    s = await decodeAs('device-secrets', pt);
  } finally {
    pt.fill(0);
  }
  if (!s) return REFUSED;
  let ok = false;
  try {
    ok = await secretsAccepted(e, s, w.device_entry_digest);
  } finally {
    if (!ok) {
      s.root_pkcs8.fill(0);
      s.ek_pkcs8.fill(0);
    }
  }
  return ok ? { secrets: s, use: e.latest ? 'current' : 'history', reason: 'ok' } : REFUSED; // check 4
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

/**
 * Wraps s to recipient under self's secrets entry entryDigest (§2.5, D-244).
 * recipient must be an active device of h's effective set with the dkx that
 * set records (activeRecipient): a removed device never receives a later wrap
 * (AC20 P3). h must be the DeviceHead verifyDeviceLedger returned just before
 * this call: this one reads no clock, so an older head can wrap the root to a
 * device whose removal the server is withholding. Null on any refusal; the
 * encoded plaintext is zeroed on every path. Never throws.
 */
export async function sealDeviceWrap(
  h: DeviceHead,
  recipient: DevRecord,
  entryDigest: Uint8Array,
  s: DeviceSecrets
): Promise<Uint8Array | null> {
  try {
    // Snapshot every input the check reads, so the seal uses exactly what was checked.
    const ids = { realm_id: h.realm_id, account_id: h.account_id };
    const to: DevRecord = { ...recipient, dkx: recipient.dkx.slice() };
    const entry = entryDigest.slice();
    if (entry.length !== ENTRY_LEN || !(await activeRecipient(h, to))) return null;
    const pt = encodeAs('device-secrets', s);
    if (!pt) return null;
    try {
      return await encryptWrap(ids, to, entry, pt);
    } finally {
      pt.fill(0);
    }
  } catch {
    return null;
  }
}
