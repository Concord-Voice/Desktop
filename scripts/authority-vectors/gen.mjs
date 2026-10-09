#!/usr/bin/env node
// gen.mjs — the #2553 account-key authority contract, second implementation.
//
// An independent Node implementation of the codec (EN1–EN6), every layout of
// the design of record's §2.5–§2.6 and §2.12 persisted heads, and the §2.4
// primitives. It writes
//   services/control-plane/internal/authoritycontract/testdata/vectors.json
// which Go (vectors_test.go) and vitest (vectors.parity.test.ts) verify.
// CI never runs it to generate; it only verifies.
//
// Dependency-free: node:fs, node:path and node:url for files, and the
// webcrypto globalThis.crypto for every hash, key and signature.
//   generate: node scripts/authority-vectors/gen.mjs
//   drift:    node scripts/authority-vectors/gen.mjs --check

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { subtle } = globalThis.crypto;
export const GENERATOR_PATH = fileURLToPath(import.meta.url);
export const VECTORS_PATH = resolve(dirname(GENERATOR_PATH),
  '../../services/control-plane/internal/authoritycontract/testdata/vectors.json');

// ── 1. EN1–EN6 ────────────────────────────────────────────────────────────

export const PREFIX = 'concord-account-authority';
export const MAX_SAFE = 9007199254740991;

export class Malformed extends Error {
  constructor(detail) {
    super(`malformed: ${detail}`);
    this.reason = 'malformed';
  }
}

const S_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:/+=-';
const S_SET = new Set(S_ALPHABET);
const EN2 = new Set([...S_ALPHABET, '"', ',', '[', ']'].map((c) => c.charCodeAt(0)));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const isUUID = (s) => UUID_RE.test(s);
export const isUUIDv4 = (s) => isUUID(s) && s[14] === '4' && '89ab'.includes(s[19]);
export const utf8 = (s) => new TextEncoder().encode(s);
export const b64e = (b) => Buffer.from(b).toString('base64');
export const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Strict base64 (RFC 4648 §3.5) plus EN5's value-level re-encode comparison.
export function b64d(s) {
  if (!B64_RE.test(s)) throw new Malformed('base64 form');
  const b = Buffer.from(s, 'base64');
  if (b.toString('base64') !== s) throw new Malformed('base64 canonical');
  return new Uint8Array(b);
}

export function parseU(s) {
  if (!/^(0|[1-9][0-9]*)$/.test(s) || s.length > 16 || BigInt(s) > BigInt(MAX_SAFE)) throw new Malformed('u');
  return Number(s);
}

// Kinds (EN3). `chk` names an extra rule; `hold` names the layout a nested
// position carries (used only to build typical vectors; the codec treats
// nested positions as opaque bytes).
const S = (max, chk) => ({ t: 's', max, chk });
const S36 = { t: 's36' };
const S36V4 = { t: 's36v4' };
const U = { t: 'u', min: 0, max: MAX_SAFE };
const U1 = { t: 'u', min: 1, max: MAX_SAFE };
const U01 = { t: 'u', min: 0, max: 1 };
const B = (n, chk) => ({ t: 'b', sizes: [n], chk });
const BONE = (...sizes) => ({ t: 'b', sizes });
const BUP = (n, hold) => ({ t: 'b', upTo: n, hold });
const E = (...vals) => ({ t: 'e', vals });
const A = (elem, min, max) => ({ t: 'a', elem, min, max });
const L = (elem, min, max) => ({ t: 'l', elem, min, max });
const opt = (k) => ({ ...k, empty: true });
const INF = Infinity;
const P97 = B(97, 'point');
const EKSPKI = B(550, 'ekspki');
const DEV = S(319, 'dev');
const D48 = B(48);
const D48o = opt(B(48));
const SIG = B(96);
const SIGo = opt(B(96));

// ── 2. Closed sets and layouts (DoR §2.5, §2.6, §2.12, §2.22, §3.3) ────────

const PUBLISHED_OPS = ['cancel_pending', 'enroll_existing', 'enroll_new', 'erase', 'recover', 'replace_root',
  'revoke_root', 'rotate_ek', 'rotate_root', 'suspend', 'unsuspend'];
const DEVICE_OPS = ['add_device', 'bind_recovery', 'cancel_recovery_bind', 'enroll_existing', 'enroll_new',
  'recover', 'replace_root', 'rotate_ek', 'rotate_root', 'unsuspend'];
const SCOPE = [...PUBLISHED_OPS, 'add_device', 'bind_recovery', 'cancel_recovery_bind', 'status'];
const STATES = ['absent', 'active', 'suspended', 'pending', 'disputed', 'erased'];
const PRIOR = ['', 'absent', 'active', 'suspended'];
const ASSURANCE = ['', 'initial', 'continuity', 'recovery', 'unverified'];
const SEGMENT = ['initial', 'continuity', 'recovery', 'unverified'];
const SUSPENDERS = ['operator', 'user'];
const ACTORS = ['operator', 'restore', 'user'];
const ROLES = ['actor-device', 'candidate', 'current-root', 'new-device', 'operator', 'recovery-key'];
export const FACTORS = ['admin-webauthn', 'backup-code', 'device-key', 'email', 'email-backup', 'erasure-list',
  'passkey', 'password', 'recovery-key', 'registration', 'session', 'sso', 'totp', 'webauthn'];
const BIND_KINDS = ['bind', 'cancel', 'unbind'];
const BIND_WAITS = ['', 'delta', 'now', 'replace'];
const SIGNED_TYPES = ['delegation', 'device-status', 'status', 'succession'];
const SECRETS_OPS = ['add_device', 'rotate_ek', 'rotate_root'];
const REFUSALS = ['authz_out_of_window', 'device_key_bound', 'device_limit', 'device_too_new', 'device_unknown',
  'ek_generation', 'ek_mismatch', 'ek_reused', 'expired', 'expiry_out_of_range', 'held', 'in_population',
  'insufficient_authorization', 'legacy_mismatch', 'malformed_for_op', 'policy_disabled', 'predecessor_mismatch',
  'recovery_key_bound', 'recovery_key_unbound', 'root_bound_elsewhere', 'root_revoked', 'root_reused',
  'stale_device_seq', 'stale_head', 'stale_recovery_gen', 'stale_seq', 'wrong_state'];
const ERRORS = ['malformed', 'bad_signature', 'bad_authz', 'request_conflict', 'too_large', 'store', 'signer',
  'clock', 'reconcile', 'not_sealed', 'busy', 'not_ready', 'not_leader', 'replication', 'disk'];

export const LAYOUTS = {
  intent: [['realm_id', S36], ['account_id', S36], ['request_id', S36V4], ['op', E(...PUBLISHED_OPS)],
    ['expires_at_ms', U1], ['expected_seq', U], ['expected_recovery_gen', U], ['expected_head_digest', D48o],
    ['predecessor_root_digest', D48o], ['candidate_root', opt(P97)], ['ek_binding_digest', D48o],
    ['legacy_ek_digest', D48o], ['device_intent_digest', D48o], ['recovery_bind_digest', D48o]],
  sig: [['role', E(...ROLES)], ['digest', D48]],
  'legacy-ek-pop': [['realm_id', S36], ['account_id', S36], ['intent_digest', D48], ['legacy_ek_digest', D48]],
  'ek-binding': [['realm_id', S36], ['account_id', S36], ['root_digest', D48], ['ek_generation', U1],
    ['ek_alg', E('rsa-oaep-4096-sha256')], ['ek_public_key', EKSPKI]],
  'cp-authz': [['realm_id', S36], ['account_id', S36], ['request_id', S36V4], ['intent_digest', D48],
    ['actor', E(...ACTORS)], ['asserted_at_ms', U1], ['evidence_digest', D48]],
  'cp-evidence': [['request_id', S36V4], ['factors', A(E(...FACTORS), 0, 14)], ['mfa_enrolled', U01],
    ['password_login', U01], ['recovery_window_clear', U01], ['operator_assisted', U01],
    ['credential_epoch_digest', D48o], ['evidence_salt', B(32)]],
  result: [['realm_id', S36], ['account_id', S36], ['request_id', S36V4], ['intent_digest', D48],
    ['cp_authz_digest', D48], ['op', E(...PUBLISHED_OPS)], ['seq', U1], ['state', E(...STATES)],
    ['prior_state', E(...PRIOR)], ['suspended_by', A(E(...SUSPENDERS), 0, 2)], ['active_root', opt(P97)],
    ['root_revoked', U01], ['ek_binding_digest', D48o], ['pending_root', opt(P97)],
    ['pending_ek_binding_digest', D48o], ['legacy_ek_digest', D48o], ['legacy_pin_revoked', U01],
    ['prev_entry_digest', D48o], ['recovery_gen', U], ['activation_not_before_ms', U],
    ['assurance', E(...ASSURANCE)], ['issued_at_ms', U], ['delegation_gen', U], ['delegation_serial', U1]],
  status: [['realm_id', S36], ['account_id', S36], ['seq', U], ['head_entry_digest', D48o], ['state', E(...STATES)],
    ['prior_state', E(...PRIOR)], ['suspended_by', A(E(...SUSPENDERS), 0, 2)], ['active_root_digest', D48o],
    ['root_revoked', U01], ['ek_binding_digest', D48o], ['pending_root_digest', D48o],
    ['pending_ek_binding_digest', D48o], ['legacy_ek_digest', D48o], ['legacy_pin_revoked', U01],
    ['activation_not_before_ms', U], ['held', U01], ['as_of_ms', U], ['valid_until_ms', U],
    ['delegation_gen', U], ['delegation_serial', U1]],
  query: [['realm_id', S36], ['account_id', S36], ['signer_digest', D48], ['issued_at_ms', U],
    ['nonce', B(16)], ['after_dseq', U]],
  delegation: [['realm_id', S36], ['serial', U1], ['min_valid_serial', U], ['product_root_gen', U],
    ['rsk_public_keys', A(P97, 1, 4)], ['cak_public_keys', A(P97, 1, 4)], ['operator_public_keys', A(P97, 0, 4)],
    ['authority_tls_keys', A(P97, 1, 8)], ['cp_tls_pins', A(D48, 1, 8)], ['not_before_ms', U],
    ['not_after_ms', U], ['scope', A(E(...SCOPE), 1, 15)], ['accepted_versions', A(S(4, 'version'), 1, 8)],
    ['tau_ms', U], ['delta_ms', U], ['g_ms', U], ['cutover_at_ms', U]],
  succession: [['realm_id', S36], ['prev_root_gen', U], ['new_root_gen', U], ['new_primary_a', P97],
    ['new_primary_b', P97], ['new_recovery_a', P97], ['new_recovery_b', P97]],
  anchors: [['realm_id', S36], ['primary_a', P97], ['primary_b', P97], ['recovery_a', P97], ['recovery_b', P97]],
  signed: [['type', E(...SIGNED_TYPES)], ['msg', BUP(4096)], ['sig_a', SIG], ['sig_b', SIGo]],
  statuses: [['items', L(BUP(6144, 'signed'), 0, 500)]],
  trust: [['items', L(BUP(6144, 'signed'), 1, 256)]],
  bundle: [['intent', BUP(2048, 'intent')], ['sig_candidate', SIGo], ['sig_current_root', SIGo],
    ['sig_operator', SIGo], ['sig_recovery', SIGo], ['legacy_pop_sig', opt(B(512))], ['legacy_spki', opt(EKSPKI)],
    ['ek_binding', opt(BUP(2048, 'ek-binding'))], ['ek_binding_sig', SIGo],
    ['recovery_bind', opt(BUP(1024, 'recovery-bind'))], ['recovery_bind_sig', SIGo],
    ['cp_authz', BUP(1024, 'cp-authz')], ['cp_authz_sig', SIGo], ['result', BUP(4096, 'result')],
    ['result_sig', SIG], ['held_status', opt(BUP(6144, 'signed'))]],
  history: [['account_id', S36], ['bundles', L(BUP(32768, 'bundle'), 0, 200)]],
  relay: [['intent', BUP(2048, 'intent')], ['sig_current_root', SIGo], ['legacy_pop_sig', opt(B(512))],
    ['legacy_spki', opt(EKSPKI)]],
  'query-req': [['query', BUP(1024, 'query')], ['query_sig', BONE(96, 512)], ['legacy_spki', opt(EKSPKI)]],
  'query-resp': [['status', opt(BUP(6144, 'signed'))], ['bundles', L(BUP(32768, 'bundle'), 0, 16)],
    ['device_status', opt(BUP(2048, 'signed'))], ['device_bundles', L(BUP(8192, 'device-bundle'), 0, 16)]],
  'device-set': [['realm_id', S36], ['account_id', S36], ['active', A(DEV, 0, 10)], ['pending', opt(DEV)],
    ['recovery_key', opt(P97)], ['recovery_bind_digest', D48o], ['replacement_key', opt(P97)],
    ['replacement_bind_digest', D48o], ['replacement_nb_ms', U]],
  'device-intent': [['realm_id', S36], ['account_id', S36], ['request_id', S36V4], ['op', E(...DEVICE_OPS)],
    ['salt', B(32)], ['expires_at_ms', U], ['expected_seq', U], ['expected_head_digest', D48o],
    ['expected_dseq', U], ['expected_device_head', D48o], ['actor_device_id', opt(S36V4)],
    ['new_device_id', opt(S36V4)], ['new_device_dsk', opt(P97)], ['new_device_dkx', opt(P97)],
    ['removed_device_ids', A(S36V4, 0, 9)], ['recovery_bind_digest', D48o], ['bind_wait', E(...BIND_WAITS)]],
  'device-result': [['realm_id', S36], ['account_id', S36], ['request_id', S36V4], ['device_intent_digest', D48],
    ['cp_authz_digest', D48o], ['op', E(...DEVICE_OPS)], ['dseq', U1], ['prev_device_entry_digest', D48o],
    ['chain_seq', U1], ['chain_entry_digest', D48], ['device_set_digest', D48], ['issued_at_ms', U],
    ['delegation_gen', U], ['delegation_serial', U1]],
  'device-status': [['realm_id', S36], ['account_id', S36], ['chain_seq', U], ['chain_head_digest', D48o],
    ['dseq', U], ['device_head_digest', D48o], ['device_set_digest', D48], ['as_of_ms', U],
    ['valid_until_ms', U], ['delegation_gen', U], ['delegation_serial', U1]],
  'device-bundle': [['device_intent', opt(BUP(2048, 'device-intent'))], ['sig_root', SIGo], ['sig_actor', SIGo],
    ['sig_new_device', SIGo], ['recovery_bind', opt(BUP(1024, 'recovery-bind'))], ['sig_recovery', SIGo],
    ['sig_recovery_prior', SIGo], ['cp_authz', opt(BUP(1024, 'cp-authz'))], ['cp_authz_sig', SIGo],
    ['device_result', BUP(1024, 'device-result')], ['device_result_sig', SIG]],
  'device-history': [['account_id', S36], ['bundles', L(BUP(8192, 'device-bundle'), 0, 16)]],
  'recovery-bind': [['realm_id', S36], ['account_id', S36], ['request_id', S36V4], ['kind', E(...BIND_KINDS)],
    ['expires_at_ms', U], ['recovery_key', opt(P97)], ['target_digest', D48o], ['chain_seq', U],
    ['chain_entry_digest', D48o], ['binding_root_digest', D48o], ['escrow_public_key', opt(P97)]],
  'device-wrap': [['realm_id', S36], ['account_id', S36], ['recipient_device_id', S36V4],
    ['device_entry_digest', D48], ['epk', P97], ['nonce', B(12)], ['ct', BUP(4096)]],
  'device-secrets': [['root_pkcs8', opt(BUP(256))], ['ek_pkcs8', BUP(2600)]],
  'relay-recover': [['intent', opt(BUP(2048, 'intent'))], ['sig_candidate', SIGo], ['sig_recovery', SIG],
    ['ek_binding', opt(BUP(2048, 'ek-binding'))], ['ek_binding_sig', SIGo],
    ['recovery_bind', opt(BUP(1024, 'recovery-bind'))], ['recovery_bind_sig', SIGo],
    ['device_intent', opt(BUP(2048, 'device-intent'))], ['sig_new_device', SIGo]],
  submit: [['intent', BUP(2048, 'intent')], ['sig_candidate', SIGo], ['sig_current_root', SIGo],
    ['sig_operator', SIGo], ['sig_recovery', SIGo], ['legacy_pop_sig', opt(B(512))], ['legacy_spki', opt(EKSPKI)],
    ['ek_binding', opt(BUP(2048, 'ek-binding'))], ['ek_binding_sig', SIGo],
    ['recovery_bind', opt(BUP(1024, 'recovery-bind'))], ['recovery_bind_sig', SIGo],
    ['cp_authz', BUP(1024, 'cp-authz')], ['cp_authz_sig', SIG], ['cp_evidence', BUP(1024, 'cp-evidence')],
    ['device_intent', opt(BUP(2048, 'device-intent'))], ['sig_actor', SIGo], ['sig_new_device', SIGo]],
  'import-item': [['bundle', opt(BUP(32768, 'bundle'))], ['device_bundle', opt(BUP(8192, 'device-bundle'))],
    ['cp_evidence', opt(BUP(1024, 'cp-evidence'))]],
  'import-batch': [['items', L(BUP(56320, 'import-item'), 1, 64)]],
  'legacy-batch': [['rows', A(S(101, 'legacyRow'), 1, 8192)]],
  committed: [['result', BUP(4096, 'result')], ['result_sig', SIG],
    ['device_result', opt(BUP(1024, 'device-result'))], ['device_result_sig', SIGo]],
  refused: [['request_id', S36V4], ['code', E(...REFUSALS)]],
  error: [['code', E(...ERRORS)]],
  head: [['status', BUP(6144, 'signed')], ['latest_bundle', opt(BUP(32768, 'bundle'))],
    ['device_status', BUP(2048, 'signed')]],
  'status-req': [['account_ids', A(S36, 1, 500)]],
  'hold-req': [['bundles', L(BUP(32768, 'bundle'), 1, 16)]],
  'pending-heads': [['account_ids', A(S36, 0, 500)], ['next', opt(S36)]],
  signer: [['realm_id', S36], ['product_root_gen', U], ['delegation_serial', U1], ['restore_epoch', U],
    ['reconciled', U01], ['max_commit_id', U], ['held_count', U], ['legacy_sealed', U01],
    ['population_digest', D48o], ['tick_age_s', U], ['cancel_unavailable_ms', U], ['extension_cap_ms', U],
    ['n_cancel_ms', U], ['v_ms', U], ['role', E('leader', 'standby')], ['rsk_digest', D48],
    ['disk_ready', U01], ['replication_required', U01], ['replication_ready', U01], ['archive_ok', U01],
    ['clock_synced', U01], ['submit_layouts', A(S(16), 1, 8)], ['trust', BUP(2097152, 'trust')]],
  'device-submit': [['device_intent', opt(BUP(2048, 'device-intent'))], ['sig_root', SIGo], ['sig_actor', SIGo],
    ['sig_new_device', SIGo], ['recovery_bind', opt(BUP(1024, 'recovery-bind'))], ['sig_recovery', SIGo],
    ['sig_recovery_prior', SIGo], ['cp_authz', BUP(1024, 'cp-authz')], ['cp_authz_sig', SIG],
    ['cp_evidence', BUP(1024, 'cp-evidence')]],
  'device-committed': [['device_bundle', BUP(8192, 'device-bundle')]],
  'chain-head': [['realm_id', S36], ['account_id', S36], ['head_result', opt(BUP(4096, 'result'))],
    ['fix', opt(BUP(6144, 'signed'))], ['active_ek_spki', opt(EKSPKI)], ['active_ek_generation', U],
    ['pending_ek_spki', opt(EKSPKI)], ['pending_ek_generation', U], ['pending_recovery_key', opt(P97)],
    ['seq_index', L(S(129, 'seqRec'), 0, INF)], ['root_index', A(S(208, 'rootRec'), 0, INF)],
    ['ek_index', A(D48, 0, INF)], ['recover_index', A(S(81, 'recoverRec'), 0, INF)]],
  'device-head': [['realm_id', S36], ['account_id', S36], ['self_device_id', opt(S36V4)],
    ['last_device_result', opt(BUP(1024, 'device-result'))], ['device_set', opt(BUP(4608, 'device-set'))],
    ['chain_head_digest', D48], ['admitted_by', A(S(73, 'admittedRec'), 0, 11)],
    ['secrets', L(S(946, 'secretsRec'), 0, INF)]],
};

export const CAPS = {
  anchors: 1024, signed: 6144, 'device-set': 4608, 'device-wrap': 6144, 'device-intent': 2048,
  'device-bundle': 8192, 'device-history': 180224, 'recovery-bind': 1024, 'relay-recover': 10278,
  'device-result': 1024, 'device-secrets': 4080, trust: 2097152, 'chain-head': 16777216, 'device-head': 16777216,
};

const b64Len = (n) => Math.ceil(n / 3) * 4;
function kmax(k) {
  switch (k.t) {
    case 's': return k.max + 2;
    case 's36': case 's36v4': return 38;
    case 'u': return String(k.max).length;
    case 'b': return b64Len(k.upTo ?? Math.max(...k.sizes)) + 2;
    case 'e': return Math.max(...k.vals.map((v) => v.length)) + 2;
    default:
      if (k.max === INF) return INF;
      return k.max === 0 ? 2 : 2 + k.max * kmax(k.elem) + k.max - 1;
  }
}

export function maxLen(tag) {
  let n = `["${PREFIX}",1,"${tag}"]`.length;
  for (const [, k] of LAYOUTS[tag]) n += 1 + kmax(k);
  return n;
}
export const capOf = (tag) => CAPS[tag] ?? maxLen(tag);

const parts = (s, n) => {
  const p = s.split('.');
  if (p.length !== n) throw new Malformed('record parts');
  return p;
};
const exact = (s, n) => {
  if (b64d(s).length !== n) throw new Malformed('record digest');
};

// Synchronous extra string rules. `dev` also needs DeviceID, which is async
// (webcrypto); decode checks it, encode checks the shape.
const STRCHK = {
  version: (s) => { if (!/^[1-9][0-9]{0,3}$/.test(s)) throw new Malformed('version'); },
  legacyRow: (s) => { const p = parts(s, 2); if (!isUUID(p[0])) throw new Malformed('legacy row'); exact(p[1], 48); },
  seqRec: (s) => { const p = parts(s, 2); exact(p[0], 48); if (p[1] !== '') exact(p[1], 48); },
  rootRec: (s) => {
    const p = parts(s, 3);
    exact(p[0], 48);
    checkPoint(b64d(p[1]));
    if (!SEGMENT.includes(p[2])) throw new Malformed('root record assurance');
  },
  recoverRec: (s) => { const p = parts(s, 2); parseU(p[0]); exact(p[1], 48); },
  admittedRec: (s) => {
    const p = parts(s, 2);
    if (!isUUIDv4(p[0]) || (p[1] !== '' && !isUUIDv4(p[1]))) throw new Malformed('admitted record');
  },
  secretsRec: (s) => {
    const p = parts(s, 4);
    exact(p[0], 48);
    if (!SECRETS_OPS.includes(p[1])) throw new Malformed('secrets record op');
    if (p[2] !== '') checkPoint(b64d(p[2]));
    checkEkSpkiTemplate(b64d(p[3]));
  },
  dev: (s) => {
    const p = s.split('.');
    if (p.length !== 4 || !isUUIDv4(p[0])) throw new Malformed('dev');
    checkPoint(b64d(p[1]));
    checkPoint(b64d(p[2]));
    parseU(p[3]);
  },
};

function checkStr(k, s) {
  if (typeof s !== 'string') throw new Malformed('not a string');
  if (s === '') {
    if (k.empty || (k.t === 'e' && k.vals.includes(''))) return;
    throw new Malformed('empty');
  }
  if (k.t === 's') {
    if (s.length > k.max || ![...s].every((c) => S_SET.has(c))) throw new Malformed('s');
    if (k.chk) STRCHK[k.chk](s);
  } else if (k.t === 's36') {
    if (!isUUID(s)) throw new Malformed('s36');
  } else if (k.t === 's36v4') {
    if (!isUUIDv4(s)) throw new Malformed('s36v4');
  } else if (k.t === 'e') {
    if (!k.vals.includes(s)) throw new Malformed('enum');
  } else {
    throw new Malformed('not a string kind');
  }
}

function checkBin(k, b) {
  const ok = k.sizes ? k.sizes.includes(b.length) : b.length >= 1 && b.length <= k.upTo;
  if (!ok) throw new Malformed('b size');
  if (k.chk === 'point') checkPoint(b);
  if (k.chk === 'ekspki') checkEkSpkiTemplate(b);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function writeValue(k, x, name) {
  switch (k.t) {
    case 's': case 's36': case 's36v4': case 'e':
      checkStr(k, x);
      return `"${x}"`;
    case 'u':
      if (!Number.isSafeInteger(x) || x < k.min || x > k.max) throw new Malformed(`${name} u`);
      return String(x);
    case 'b':
      if (x.length === 0) {
        if (!k.empty) throw new Malformed(`${name} empty`);
        return '""';
      }
      checkBin(k, x);
      return `"${b64e(x)}"`;
    default: {
      if (x.length < k.min || x.length > k.max) throw new Malformed(`${name} count`);
      const items = x.map((it) => {
        if (it.length === 0) throw new Malformed(`${name} empty item`);
        if (k.elem.t === 'b') {
          checkBin(k.elem, it);
          return b64e(it);
        }
        checkStr(k.elem, it);
        return it;
      });
      if (k.t === 'a') {
        items.sort(cmp);
        for (let i = 1; i < items.length; i++) if (items[i] === items[i - 1]) throw new Malformed(`${name} duplicate`);
      }
      return `[${items.map((s) => `"${s}"`).join(',')}]`;
    }
  }
}

// Cross-position rules the design of record names malformed and that read
// only the message's own positions (the plan's A1 list).
const CROSS = {
  signed: (v) => {
    const want = utf8(`["${PREFIX}",1,"${v.type}",`);
    if (!equalBytes(v.msg.subarray(0, want.length), want)) throw new Malformed('signed type is not msg[2]');
    const dual = v.type === 'delegation' || v.type === 'succession';
    if (dual && v.sig_b.length === 0) throw new Malformed('missing second signature');
    if (!dual && v.sig_b.length !== 0) throw new Malformed('unexpected second signature');
  },
  'relay-recover': (v) => {
    const has = (n) => v[n].length > 0;
    const rest = ['sig_candidate', 'ek_binding', 'ek_binding_sig', 'recovery_bind_sig', 'device_intent', 'sig_new_device'].some(has);
    const formR = ['intent', 'sig_candidate', 'ek_binding', 'ek_binding_sig', 'recovery_bind', 'recovery_bind_sig',
      'device_intent', 'sig_new_device'].every(has);
    const formC = has('intent') && !has('recovery_bind') && !rest;
    const formB = !has('intent') && has('recovery_bind') && !rest;
    if (!formR && !formC && !formB) throw new Malformed('relay-recover form');
  },
  'device-set': (v) => {
    if (v.pending !== '') {
      const prefix = v.pending.slice(0, v.pending.indexOf('.') + 1);
      if (v.active.some((d) => d.startsWith(prefix))) throw new Malformed('pending is in active');
    }
    // §2.5: "IDs are pairwise distinct". Strict ascending order does not imply it
    // (id.dsk.dkx.5 < id.dsk.dkx.6), so compare the 36-character ids directly.
    const ids = v.active.map((d) => d.slice(0, 36)).sort(cmp);
    for (let i = 1; i < ids.length; i++) if (ids[i] === ids[i - 1]) throw new Malformed('duplicate device id');
    const bound = v.recovery_key.length > 0;
    const slot = v.replacement_bind_digest.length > 0;
    const hasKey = v.replacement_key.length > 0;
    if (bound !== v.recovery_bind_digest.length > 0) throw new Malformed('recovery key and digest');
    if (slot !== (v.replacement_nb_ms !== 0)) throw new Malformed('slot digest and nb');
    if (!slot && hasKey) throw new Malformed('slot key without digest');
    if (slot && !hasKey && !bound) throw new Malformed('pending unbind without a bound key');
    if (hasKey && equalBytes(v.replacement_key, v.recovery_key)) throw new Malformed('refresh to the bound key');
  },
  'recovery-bind': (v) => {
    if (v.escrow_public_key.length > 0 && equalBytes(v.escrow_public_key, v.recovery_key)) {
      throw new Malformed('escrow key equals the recovery key');
    }
  },
};

// encode is EN6: it validates every position (dev shape only) and writes.
export function encode(tag, v) {
  const fields = LAYOUTS[tag];
  if (!fields) throw new Malformed('unknown layout');
  let out = `["${PREFIX}",1,"${tag}"`;
  for (const [name, k] of fields) out += ',' + writeValue(k, v[name], name);
  out += ']';
  CROSS[tag]?.(v);
  if (out.length > capOf(tag)) throw new Malformed('length');
  return utf8(out);
}

async function readValue(k, x) {
  switch (k.t) {
    case 's': case 's36': case 's36v4': case 'e':
      checkStr(k, x);
      if (k.chk === 'dev' && x !== '') await parseDev(x);
      return x;
    case 'u':
      if (!Number.isSafeInteger(x) || x < k.min || x > k.max) throw new Malformed('u');
      return x;
    case 'b': {
      if (typeof x !== 'string') throw new Malformed('not a string');
      if (x === '') {
        if (!k.empty) throw new Malformed('empty');
        return new Uint8Array(0);
      }
      const b = b64d(x);
      checkBin(k, b);
      return b;
    }
    default: {
      if (!Array.isArray(x) || x.length < k.min || x.length > k.max) throw new Malformed('items');
      const out = [];
      for (let i = 0; i < x.length; i++) {
        if (typeof x[i] !== 'string' || x[i] === '') throw new Malformed('array item');
        if (k.t === 'a' && i > 0 && !(x[i - 1] < x[i])) throw new Malformed('not strictly ascending');
        out.push(await readValue(k.elem, x[i]));
      }
      return out;
    }
  }
}

// decode is EN5 (JS form: JSON.parse plus Number.isSafeInteger).
export async function decode(tag, bytes, limit) {
  const fields = LAYOUTS[tag];
  if (!fields) throw new Malformed('unknown layout');
  if (bytes.length > (limit ?? capOf(tag))) throw new Malformed('length');            // 1
  for (const c of bytes) if (!EN2.has(c)) throw new Malformed('EN2');                  // 2
  let arr;
  try {
    arr = JSON.parse(Buffer.from(bytes).toString('latin1'));                            // 3
  } catch {
    throw new Malformed('json');
  }
  if (!Array.isArray(arr) || arr.length !== 3 + fields.length) throw new Malformed('count'); // 4
  if (arr[0] !== PREFIX || arr[1] !== 1 || arr[2] !== tag) throw new Malformed('prefix, version or type');
  const v = {};
  for (let i = 0; i < fields.length; i++) v[fields[i][0]] = await readValue(fields[i][1], arr[3 + i]); // 5
  if (!equalBytes(encode(tag, v), bytes)) throw new Malformed('re-encode');             // 6 (+ CROSS)
  return v;
}

// ── 3. §2.4 primitives and canonical texts ────────────────────────────────

const P384_P = 2n ** 384n - 2n ** 128n - 2n ** 96n + 2n ** 32n - 1n;
const P384_B = 0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn;
const big = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const modp = (a) => ((a % P384_P) + P384_P) % P384_P;

// checkPoint is the codec's own curve check (y² = x³ − 3x + b over P-384).
export function checkPoint(b) {
  if (b.length !== 97 || b[0] !== 0x04) throw new Malformed('point form');
  const x = big(b.subarray(1, 49));
  const y = big(b.subarray(49));
  if (x >= P384_P || y >= P384_P) throw new Malformed('point range');
  if (modp(y * y) !== modp(x * x * x - 3n * x + P384_B)) throw new Malformed('point not on curve');
}

// The canonical 550-byte SPKI of an RSA-4096 key with e = 65537 has a fixed
// 33-byte header and 5-byte trailer around a 512-byte modulus with its top bit set.
const EK_HDR = Buffer.from('30820222300d06092a864886f70d01010105000382020f003082020a0282020100', 'hex');
const EK_TRL = Buffer.from('0203010001', 'hex');
export function checkEkSpkiTemplate(b) {
  if (b.length !== 550 || !equalBytes(b.subarray(0, 33), EK_HDR) || !equalBytes(b.subarray(545), EK_TRL) ||
      (b[33] & 0x80) === 0) {
    throw new Malformed('ek spki');
  }
}

// checkEkSpkiWebCrypto is the design of record's Web Crypto procedure (§2.4).
export async function checkEkSpkiWebCrypto(b) {
  if (b.length !== 550) throw new Malformed('ek spki length');
  let key;
  try {
    key = await subtle.importKey('spki', b, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['encrypt']);
  } catch {
    throw new Malformed('ek spki parse');
  }
  if (key.algorithm.modulusLength !== 4096) throw new Malformed('ek modulus');
  if (!equalBytes(key.algorithm.publicExponent, new Uint8Array([1, 0, 1]))) throw new Malformed('ek exponent');
  if (!equalBytes(new Uint8Array(await subtle.exportKey('spki', key)), b)) throw new Malformed('ek spki not canonical');
}

export const sha384 = async (b) => new Uint8Array(await subtle.digest('SHA-384', b));

// importP384 checks len == 97 and the 0x04 prefix BEFORE importKey: Node
// accepts a correct-parity 0x06/0x07 hybrid point (measured, v26.7.0).
export async function importP384(b) {
  if (b.length !== 97 || b[0] !== 0x04) throw new Malformed('point_prefix');
  try {
    return await subtle.importKey('raw', b, { name: 'ECDSA', namedCurve: 'P-384' }, true, ['verify']);
  } catch {
    throw new Malformed('point');
  }
}

export async function verifyP384(point, msg, sig) {
  let key;
  try {
    key = await importP384(point);
  } catch {
    return false;
  }
  if (sig.length !== 96) return false;
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-384' }, key, sig, msg);
}

export async function verifyLegacyPSS(spki, msg, sig) {
  try {
    await checkEkSpkiWebCrypto(spki);
  } catch {
    return false;
  }
  if (sig.length !== 512) return false;
  const key = await subtle.importKey('spki', spki, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify']);
  return subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, key, sig, msg);
}

export async function deviceId(dsk) {
  const h = await sha384(concat(utf8('concord-device-id/v1'), [0], dsk));
  const b = h.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = Buffer.from(b).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export async function parseDev(s) {
  STRCHK.dev(s);
  if (s.length > 319) throw new Malformed('dev length');
  const [id, dskB64, dkxB64, mature] = s.split('.');
  const dsk = b64d(dskB64);
  if ((await deviceId(dsk)) !== id) throw new Malformed('dev id is not DeviceID(dsk)');
  return { id, dsk, dkx: b64d(dkxB64), matureAtMs: parseU(mature) };
}

export async function safetyNumber(accountId, pinDigest) {
  if (!isUUID(accountId) || pinDigest.length !== 48) return '';
  const h = new Uint8Array(await subtle.digest('SHA-512',
    concat(utf8('concord-safety-number/v1'), [0], utf8(accountId), pinDigest)));
  const groups = [];
  for (let i = 0; i < 12; i++) {
    let v = 0;
    for (const c of h.subarray(5 * i, 5 * i + 5)) v = v * 256 + c;
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

const HEX64 = /^[0-9a-f]{64}$/;
const CLIENT_V = /^[0-9A-Za-z.+-]{1,32}$/;

export function ageClaimV2Bytes(c) {
  // valid_age and nsfw_auth are Go's %t: only a real boolean formats as true or false.
  if (typeof c.valid_age !== 'boolean' || typeof c.nsfw_auth !== 'boolean' ||
      !isUUID(c.user_id) || !isUUIDv4(c.device_id) || !HEX64.test(c.nonce) || !CLIENT_V.test(c.client_version) ||
      !Number.isInteger(c.jurisdiction_obligation) || c.jurisdiction_obligation < 0 || c.jurisdiction_obligation > 2 ||
      !Number.isSafeInteger(c.timestamp) || c.timestamp <= 0) {
    return null;
  }
  return utf8(`age-claim/v2\ncanonical_version=2\nuser_id=${c.user_id}\nvalid_age=${c.valid_age}\n` +
    `nsfw_auth=${c.nsfw_auth}\njurisdiction_obligation=${c.jurisdiction_obligation}\nnonce=${c.nonce}\n` +
    `timestamp=${c.timestamp}\ndevice_id=${c.device_id}\nclient_version=${c.client_version}`);
}

export function sessionBindBytes(b) {
  if (![b.realm_id, b.user_id, b.session_id].every(isUUID) || !isUUIDv4(b.device_id) || !HEX64.test(b.challenge) ||
      !Number.isSafeInteger(b.issued_at_ms) || b.issued_at_ms <= 0) {
    return null;
  }
  return utf8(`concord-session-bind/v1\nrealm_id=${b.realm_id}\nuser_id=${b.user_id}\ndevice_id=${b.device_id}\n` +
    `session_id=${b.session_id}\nchallenge=${b.challenge}\nissued_at_ms=${b.issued_at_ms}`);
}

export async function credentialEpochDigest(epoch, valid) {
  return !valid || epoch === '' ? null : sha384(utf8(epoch));
}

export async function populationDigest(records) {
  const sorted = [...records].sort((a, b) => cmp(a.account_id, b.account_id));
  for (let i = 0; i < sorted.length; i++) {
    if (!isUUID(sorted[i].account_id) || sorted[i].legacy_ek_digest.length !== 48) throw new Malformed('population record');
    if (i > 0 && sorted[i - 1].account_id === sorted[i].account_id) throw new Malformed('duplicate account');
  }
  return sha384(concat(...sorted.flatMap((r) => [utf8(r.account_id), r.legacy_ek_digest])));
}

export async function tlsPin(point) {
  const key = await importP384(point);
  return sha384(new Uint8Array(await subtle.exportKey('spki', key)));
}

export async function generatorDigest() {
  return Buffer.from(await sha384(readFileSync(GENERATOR_PATH))).toString('hex');
}

// vectorsDigest is SHA-384 over every byte after the file's header line, which
// is where the vectors are. Keys are drawn fresh each run, so the file cannot be
// regenerated and compared; this records what the generator wrote instead. It
// catches an edit made without running the generator. It is not tamper-proof:
// whoever edits the file can recompute it.
// HEADER_LINE is the exact first line renderVectorFile writes. The digest covers
// only what follows it, so the line must hold nothing else: a vector inserted
// after "vectors":[ on this line would otherwise sit outside the commitment.
export const HEADER_LINE = /^\{"generator_sha384":"[0-9a-f]{96}","vectors_sha384":"[0-9a-f]{96}","vectors":\[$/;

export async function vectorsDigest(body) {
  return Buffer.from(await sha384(Buffer.from(body, 'utf8'))).toString('hex');
}

// checkDrift is the pre-commit hook: generator_sha384 must be SHA-384(gen.mjs),
// and vectors_sha384 must match the vectors the file holds.
export async function checkDrift(path = VECTORS_PATH) {
  const text = readFileSync(path, 'utf8');
  const file = JSON.parse(text);
  const want = await generatorDigest();
  if (file.generator_sha384 !== want) {
    throw new Error(`vectors.json was written by another gen.mjs (file ${file.generator_sha384}, generator ${want}); ` +
      'run: node scripts/authority-vectors/gen.mjs');
  }
  const newline = text.indexOf('\n');
  if (newline < 0 || !HEADER_LINE.test(text.slice(0, newline))) {
    throw new Error('vectors.json header line is not the form gen.mjs writes; run: node scripts/authority-vectors/gen.mjs');
  }
  const content = await vectorsDigest(text.slice(newline + 1));
  if (file.vectors_sha384 !== content) {
    throw new Error(`vectors.json was edited after gen.mjs wrote it (recorded ${file.vectors_sha384}, content ${content}); ` +
      'run: node scripts/authority-vectors/gen.mjs');
  }
}

// ── 4. Vectors (DoR §3.1: the codec and primitive part; PR-A2 appends to BUILDERS) ──

const BUDGET = 128 * 1024;
const CAP_VECTOR_BUDGET = 256 * 1024;
const POOL = 32;
const E0 = new Uint8Array(0);
const TYPICAL = { count: 'typical', item: 'typical' };
const OK = (reenc) => ({ reason: 'ok', verdict: 'ok', ...(reenc ? { reencoded_b64: b64e(reenc) } : {}) });
const BAD = { reason: 'malformed', verdict: 'withhold' };
const BADSIG = { reason: 'bad_signature', verdict: 'withhold' };
const B64CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const text = (b) => Buffer.from(b).toString('latin1');
const raw = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
export const RUNTIME_ONLY = [];

function rnd(n) {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  return out;
}

const keys = [];
async function ecKey(i) {
  while (keys.length <= i) keys.push(await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']));
  return keys[i];
}
const pointAt = async (i) => new Uint8Array(await subtle.exportKey('raw', (await ecKey(i % POOL)).publicKey));
let pointSeq = 0;
const nextPoint = () => pointAt(pointSeq++);
async function pointWithParity(par) {
  for (let i = 0; ; i++) {
    const p = await pointAt(i);
    if ((p[96] & 1) === par) return p;
  }
}

let ekCache;
async function ek() {
  if (!ekCache) {
    const kp = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    ekCache = { kp, spki: new Uint8Array(await subtle.exportKey('spki', kp.publicKey)) };
  }
  return ekCache;
}

async function devString(mature) {
  const dsk = await nextPoint();
  const dkx = await nextPoint();
  return `${await deviceId(dsk)}.${b64e(dsk)}.${b64e(dkx)}.${mature}`;
}

// Samplers for the string kinds that carry a rule (all produce distinct items by i).
const GEN = {
  dev: (max) => devString(max ? MAX_SAFE : 1),
  version: async (max, i) => String(max ? 1000 + i : 1 + i),
  legacyRow: async (_max, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}.${b64e(rnd(48))}`,
  seqRec: async (max) => `${b64e(rnd(48))}.${max ? b64e(rnd(48)) : ''}`,
  rootRec: async (max) => `${b64e(rnd(48))}.${b64e(await nextPoint())}.${max ? 'continuity' : 'initial'}`,
  recoverRec: async (max, i) => `${max ? MAX_SAFE - i : 1 + i}.${b64e(rnd(48))}`,
  admittedRec: async (max) => `${crypto.randomUUID()}.${max ? crypto.randomUUID() : ''}`,
  secretsRec: async (max) =>
    `${b64e(rnd(48))}.${max ? 'rotate_root' : 'rotate_ek'}.${max ? b64e(await nextPoint()) : ''}.${b64e((await ek()).spki)}`,
};

async function sampleScalar(k, mode, i) {
  const max = mode === 'max';
  if (k.chk && GEN[k.chk]) return GEN[k.chk](max, i);
  switch (k.t) {
    case 's': return max ? String(i).padStart(k.max, 'a') : `layout/${i}`;
    case 's36': case 's36v4': return crypto.randomUUID();
    case 'u': return max ? k.max : Math.max(k.min, 1);
    case 'e': {
      const vs = k.vals.filter((x) => x !== '');
      return max ? vs.reduce((a, b) => (b.length > a.length ? b : a)) : vs[0];
    }
    case 'b': {
      if (k.chk === 'point') return nextPoint();
      if (k.chk === 'ekspki') return (await ek()).spki;
      const cap = k.upTo ?? Math.max(...k.sizes);
      if (max) return rnd(cap);
      if (mode === 'typical' && k.hold) return typicalBytes(k.hold);
      return rnd(k.sizes ? k.sizes[0] : mode === 'typical' ? Math.min(cap, 16) : 1);
    }
    default: throw new Error(`no sampler for ${k.t}`);
  }
}

async function sampleField(k, opts) {
  if (k.t !== 'a' && k.t !== 'l') return sampleScalar(k, opts.item === 'max' && kmax(k) > BUDGET ? 'min' : opts.item, 0);
  let n = opts.count === 'max' ? k.max : opts.count === 'one' ? 1 : Math.max(1, k.min);
  if (n === INF) n = 1;
  n = Math.min(Math.max(n, k.min), k.max);
  if (k.elem.t === 'e') return k.elem.vals.filter((x) => x !== '').slice(0, n);
  const items = [];
  for (let i = 0; i < n; i++) items.push(await sampleScalar(k.elem, opts.item, i));
  return items;
}

// FIXUP makes typical values meaningful and keeps the A1 cross rules true.
const FIXUP = {
  signed: async (v, opts) => {
    if (opts.item === 'max') {
      v.type = 'delegation';
      const head = utf8(`["${PREFIX}",1,"delegation",`);
      v.msg = concat(head, rnd(4096 - head.length));
    } else {
      v.type = 'status';
      v.msg = await typicalBytes('status');
      v.sig_b = E0;
    }
  },
  'relay-recover': async (v, opts) => {
    if (opts.count !== 'typical') return;
    for (const n of ['intent', 'sig_candidate', 'ek_binding', 'ek_binding_sig', 'recovery_bind_sig', 'device_intent', 'sig_new_device']) v[n] = E0;
  },
  'recovery-bind': async (v) => {
    if (v.kind === 'bind') {
      v.target_digest = E0;
      v.expires_at_ms = 0;
    }
  },
  'cp-evidence': async (v, opts) => {
    if (opts.count === 'typical') v.factors = ['password', 'totp'];
  },
  // The public-mirror gate (scripts/public-mirror/gitleaks-gate.toml) decodes the
  // base64 in vectors.json and scans the decoded layout text with gitleaks'
  // `generic-api-key` rule. That rule fires on a high-entropy value right after a
  // tag that contains a credential keyword: "cp-authz" ("auth") followed by its
  // random realm_id UUID, and "device-secrets" ("secret") followed by its random
  // key bytes. Nothing here is a credential, so give just those positions
  // low-entropy values: same kind, same length, only the byte values change.
  'cp-authz': async (v) => {
    v.realm_id = '11111111-1111-4111-8111-111111111111';
  },
  'device-secrets': async (v) => {
    for (const n of ['root_pkcs8', 'ek_pkcs8']) v[n] = new Uint8Array(v[n].length);
  },
};

export async function buildValues(tag, opts) {
  const v = {};
  for (const [name, k] of LAYOUTS[tag]) v[name] = await sampleField(k, opts);
  await FIXUP[tag]?.(v, opts);
  return v;
}

const typicalCache = new Map();
async function typicalBytes(tag) {
  if (!typicalCache.has(tag)) typicalCache.set(tag, encode(tag, await buildValues(tag, TYPICAL)));
  return typicalCache.get(tag);
}

// encodeRaw writes `overrides` (raw JSON tokens) in place of some positions and
// skips the cross rules: it builds negative vectors.
function encodeRaw(tag, v, overrides) {
  let out = `["${PREFIX}",1,"${tag}"`;
  for (const [name, k] of LAYOUTS[tag]) out += ',' + (name in overrides ? overrides[name] : writeValue(k, v[name], name));
  return raw(out + ']');
}

async function derSig() {
  const p1363 = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, (await ecKey(0)).privateKey, utf8('der')));
  const int = (x) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    let v = x.subarray(i);
    if (v[0] & 0x80) v = concat([0], v);
    return concat([0x02, v.length], v);
  };
  const body = concat(int(p1363.subarray(0, 48)), int(p1363.subarray(48)));
  return concat([0x30, body.length], body);
}

let badSpkiCache;
async function badSpkis() {
  if (badSpkiCache) return badSpkiCache;
  const { spki } = await ek();
  const rsa = async (bits, e) => new Uint8Array(await subtle.exportKey('spki', (await subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: bits, publicExponent: new Uint8Array(e), hash: 'SHA-256' }, true,
    ['encrypt', 'decrypt'])).publicKey));
  const e65539 = spki.slice();
  e65539[549] = 0x03;
  const pssOid = spki.slice();
  pssOid[16] = 0x0a;
  badSpkiCache = [['2048-bit', await rsa(2048, [1, 0, 1])], ['e-3', await rsa(4096, [3])], ['e-65539', e65539],
    ['pss-oid', pssOid], ['absent-null', concat([0x30, 0x82, 0x02, 0x20, 0x30, 0x0b], spki.subarray(6, 17), spki.subarray(19))],
    ['trailing-bytes', concat(spki, [0, 0])]];
  return badSpkiCache;
}

// A negative vector longer than its layout's cap is refused at EN5 step 1 (length)
// and never reaches the rule its name gives, and neg() cannot tell, because any
// Malformed passes. So neg() fails generation for such a vector unless its name ends
// in `cap-plus-one` (length IS the rule there) or it is listed here with the reason
// the length check is the only one it can reach. An entry that is not over its cap
// also fails: a stale entry would hide the next vector that is.
const LENGTH_BOUND = {
  'neg/legacy-ek-pop/extra-element':
    'fixed-width layout: its typical vector already equals maxLen, so one more element can only fail the length check',
  'neg/legacy-ek-pop/age-claim-text': 'the age-claim/v2 text (295 B) exceeds the 259-byte cap, so EN5 step 1 refuses it before EN2 can see the LF',
  'neg/query/age-claim-text': 'the age-claim/v2 text (295 B) exceeds the 245-byte cap, so EN5 step 1 refuses it before EN2 can see the LF',
  'neg/sig/session-bind-text': 'the session-bind/v1 text (311 B) exceeds the 119-byte cap, so EN5 step 1 refuses it before EN2 can see the LF',
  'neg/sig/a-legacy-ek-pop': 'a whole legacy-ek-pop (259 B) exceeds sig\'s 119-byte cap; neg/sig/wrong-type is the vector that reaches the type check',
};

function makeCtx() {
  const out = [];
  const names = new Set();
  const push = (v) => {
    if (names.has(v.name)) throw new Error(`duplicate vector ${v.name}`);
    names.add(v.name);
    out.push(v);
  };
  const pos = async (name, type, bytes) => {
    await decode(type, bytes); // self-check: this implementation accepts it
    push({ name, type, bytes_b64: b64e(bytes), expect: OK(bytes) });
  };
  const neg = async (name, type, bytes) => {
    const over = bytes.length > capOf(type);
    const declared = name.endsWith('cap-plus-one') || Object.hasOwn(LENGTH_BOUND, name);
    if (over && !declared) throw new Error(`self-check: negative vector ${name} is ${bytes.length} bytes, over the ${capOf(type)}-byte cap of ${type}: it is refused by length, not by its own rule`);
    if (!over && declared) throw new Error(`self-check: negative vector ${name} is declared length-bound but fits the ${capOf(type)}-byte cap of ${type}`);
    try {
      await decode(type, bytes);
    } catch (e) {
      if (!(e instanceof Malformed)) throw e;
      push({ name, type, bytes_b64: b64e(bytes), expect: BAD });
      return;
    }
    throw new Error(`self-check: negative vector ${name} decoded`);
  };
  return { out, push, pos, neg, typical: {} };
}

async function maxVectors(tag) {
  if (maxLen(tag) <= BUDGET) return [['max', encode(tag, await buildValues(tag, { count: 'max', item: 'max' }))]];
  const out = [];
  for (const [variant, opts] of [['max-count', { count: 'max', item: 'min' }], ['max-item', { count: 'one', item: 'max' }]]) {
    const b = encode(tag, await buildValues(tag, opts));
    if (b.length <= BUDGET) {
      out.push([variant, b]);
    } else {
      await decode(tag, b); // checked here, never committed
      RUNTIME_ONLY.push(`${tag}/${variant}`);
    }
  }
  return out;
}

async function emptiesVector(tag) {
  const v = await buildValues(tag, TYPICAL);
  let changed = false;
  for (const [name, k] of LAYOUTS[tag]) {
    if (k.empty) {
      v[name] = k.t === 'b' ? E0 : '';
      changed = true;
    } else if ((k.t === 'a' || k.t === 'l') && k.min === 0 && v[name].length > 0) {
      v[name] = [];
      changed = true;
    }
  }
  if (tag === 'device-set') v.replacement_nb_ms = 0;
  if (!changed) return null;
  try {
    const b = encode(tag, v);
    await decode(tag, b);
    return b;
  } catch (e) {
    if (e instanceof Malformed) return null;
    throw e;
  }
}

async function everyLayout(ctx) {
  for (const tag of Object.keys(LAYOUTS).filter((t) => t !== 'chain-head' && t !== 'device-head')) {
    const t = await typicalBytes(tag);
    ctx.typical[tag] = t;
    await ctx.pos(`pos/${tag}/typical`, tag, t);
    const s = text(t);
    // sig's typical role is its longest, leaving no room for a fourth element under
    // the cap; role operator frees 4 bytes, so the extra element reaches the count check.
    const x = tag === 'sig' ? text(encode('sig', { ...(await buildValues('sig', TYPICAL)), role: 'operator' })) : s;
    await ctx.neg(`neg/${tag}/extra-element`, tag, raw(x.slice(0, -1) + ',""]'));
    await ctx.neg(`neg/${tag}/missing-element`, tag, raw(s.slice(0, s.lastIndexOf(',')) + ']'));
    // sig and legacy-ek-pop are at their cap, so a longer tag would only fail the length
    // check; a same-length tag reaches the prefix, version and type check.
    const wrong = { sig: 'siq', 'legacy-ek-pop': 'legacy-ek-poq' }[tag] ?? `${tag}x`;
    await ctx.neg(`neg/${tag}/wrong-type`, tag, raw(s.replace(`,"${tag}",`, `,"${wrong}",`)));
    for (const [variant, b] of await maxVectors(tag)) await ctx.pos(`pos/${tag}/${variant}`, tag, b);
    const e = await emptiesVector(tag);
    if (e) await ctx.pos(`pos/${tag}/empties`, tag, e);
  }
  for (const [tag, cap] of Object.entries(CAPS)) {
    if (cap + 1 <= CAP_VECTOR_BUDGET) await ctx.neg(`neg/${tag}/cap-plus-one`, tag, new Uint8Array(cap + 1).fill(65));
  }
}

async function parsing(ctx) {
  const sv = await buildValues('status', TYPICAL);
  for (const [n, tok] of [['u-2^53', '9007199254740992'], ['u-1.0', '1.0'], ['u-1e0', '1e0'], ['u-negative', '-1'],
    ['u-string', '"1"'], ['u-bool', 'true'], ['u-null', 'null'], ['u-nested-array', '[1]']]) {
    await ctx.neg(`neg/status/${n}`, 'status', encodeRaw('status', sv, { as_of_ms: tok }));
  }
  const st = text(encode('status', sv));
  await ctx.neg('neg/status/bom', 'status', concat([0xef, 0xbb, 0xbf], raw(st)));
  await ctx.neg('neg/status/space', 'status', raw(st.replace('",1,"status"', '", 1,"status"')));
  await ctx.neg('neg/status/escape', 'status', encodeRaw('status', sv, { realm_id: '"\\u0061"' }));
  await ctx.neg('neg/status/non-ascii', 'status', encodeRaw('status', sv, { realm_id: '"\xc3\xa9"' }));
  await ctx.neg('neg/status/invalid-utf8', 'status', encodeRaw('status', sv, { realm_id: '"\xff"' }));
  await ctx.neg('neg/status/version-2', 'status', raw(st.replace('",1,"status"', '",2,"status"')));
  await ctx.neg('neg/status/version-1.0', 'status', raw(st.replace('",1,"status"', '",1.0,"status"')));
  await ctx.neg('neg/status/prefix', 'status', raw(st.replace(`"${PREFIX}"`, '"concord-account-authorit"')));
  await ctx.neg('neg/status/nested-array-at-s', 'status', encodeRaw('status', sv, { realm_id: `["${sv.realm_id}"]` }));
  await ctx.neg('neg/status/object', 'status', raw('{"a":1}'));
  await ctx.neg('neg/status/trailing-bytes', 'status', raw(st + ']'));
}

async function arraysAndEvidence(ctx) {
  const dv = await buildValues('delegation', { count: 'max', item: 'typical' });
  const dt = text(encode('delegation', dv));
  const cak = JSON.parse(dt)[8];
  await ctx.neg('neg/delegation/a-unsorted', 'delegation', raw(dt.replace(`"${cak[0]}","${cak[1]}"`, `"${cak[1]}","${cak[0]}"`)));
  await ctx.neg('neg/delegation/a-duplicate', 'delegation', raw(dt.replace(`"${cak[0]}","${cak[1]}"`, `"${cak[0]}","${cak[0]}"`)));
  await ctx.neg('neg/delegation/a-nested-array', 'delegation', raw(dt.replace(`"${cak[0]}"`, `["${cak[0]}"]`)));
  await ctx.neg('neg/delegation/a-over-count', 'delegation', encodeRaw('delegation', dv,
    { cak_public_keys: `[${[...cak, b64e(await nextPoint())].sort(cmp).map((s) => `"${s}"`).join(',')}]` }));
  await ctx.neg('neg/delegation/version-0', 'delegation', encodeRaw('delegation', dv, { accepted_versions: '["0"]' }));
  await ctx.neg('neg/delegation/version-10000', 'delegation', encodeRaw('delegation', dv, { accepted_versions: '["10000"]' }));
  await ctx.neg('neg/delegation/scope-device-status', 'delegation', encodeRaw('delegation', dv, { scope: '["device-status"]' }));
  const ev = await buildValues('cp-evidence', TYPICAL);
  await ctx.pos('pos/cp-evidence/all-14-factors', 'cp-evidence', encode('cp-evidence', { ...ev, factors: [...FACTORS] }));
  await ctx.neg('neg/cp-evidence/backup-email-recovery', 'cp-evidence', encodeRaw('cp-evidence', ev, { factors: '["backup-email-recovery"]' }));
  await ctx.neg('neg/cp-evidence/duplicate-factor', 'cp-evidence', encodeRaw('cp-evidence', ev, { factors: '["password","password"]' }));
  await ctx.neg('neg/cp-evidence/unsorted-factors', 'cp-evidence', encodeRaw('cp-evidence', ev, { factors: '["totp","password"]' }));
}

async function base64AndKeys(ctx) {
  const qv = await buildValues('query', TYPICAL);
  const nonce = b64e(qv.nonce);
  const strictBad = nonce.slice(0, 21) + B64CH[B64CH.indexOf(nonce[21]) | 1] + '==';
  await ctx.neg('neg/query/base64-QR', 'query', encodeRaw('query', qv, { nonce: '"QR=="' }));
  await ctx.neg('neg/query/base64-trailing-bits', 'query', encodeRaw('query', qv, { nonce: `"${strictBad}"` }));
  await ctx.neg('neg/query/base64-missing-padding', 'query', encodeRaw('query', qv, { nonce: `"${nonce.slice(0, 22)}"` }));
  await ctx.neg('neg/query/base64-newline', 'query', encodeRaw('query', qv, { nonce: `"${nonce.slice(0, 12)}\n${nonce.slice(12)}"` }));

  const av = await buildValues('anchors', TYPICAL);
  const p = av.primary_a;
  const hybrid = p.slice();
  hybrid[0] = 0x06 | (p[96] & 1);
  const off = p.slice();
  off[96] ^= 1;
  for (const [n, b] of [['compressed', concat([0x02 | (p[96] & 1)], p.subarray(1, 49))], ['off-curve', off],
    ['hybrid', hybrid], ['infinity', new Uint8Array([0])], ['short', p.subarray(0, 96)]]) {
    await ctx.neg(`neg/anchors/point-${n}`, 'anchors', encodeRaw('anchors', av, { primary_a: `"${b64e(b)}"` }));
  }

  const bv = await buildValues('bundle', TYPICAL);
  await ctx.neg('neg/bundle/sig-95', 'bundle', encodeRaw('bundle', bv, { result_sig: `"${b64e(rnd(95))}"` }));
  await ctx.neg('neg/bundle/sig-97', 'bundle', encodeRaw('bundle', bv, { result_sig: `"${b64e(rnd(97))}"` }));
  await ctx.neg('neg/bundle/sig-der', 'bundle', encodeRaw('bundle', bv, { result_sig: `"${b64e(await derSig())}"` }));
  await ctx.neg('neg/bundle/pss-511', 'bundle', encodeRaw('bundle', bv, { legacy_pop_sig: `"${b64e(rnd(511))}"` }));

  const ekv = await buildValues('ek-binding', TYPICAL);
  for (const [n, b] of await badSpkis()) {
    await ctx.neg(`neg/ek-binding/spki-${n}`, 'ek-binding', encodeRaw('ek-binding', ekv, { ek_public_key: `"${b64e(b)}"` }));
  }

  const iv = await buildValues('intent', TYPICAL);
  await ctx.neg('neg/intent/request-id-v1', 'intent', encodeRaw('intent', iv, { request_id: '"6ba7b810-9dad-11d1-80b4-00c04fd430c8"' }));
  await ctx.neg('neg/intent/realm-uppercase', 'intent', encodeRaw('intent', iv, { realm_id: `"${iv.realm_id.toUpperCase()}"` }));
  await ctx.neg('neg/intent/private-op', 'intent', encodeRaw('intent', iv, { op: '"add_device"' }));
  await ctx.neg('neg/intent/expires-zero', 'intent', encodeRaw('intent', iv, { expires_at_ms: '0' }));
  await ctx.neg('neg/sig/role-admin', 'sig', encodeRaw('sig', await buildValues('sig', TYPICAL), { role: '"admin"' }));
  await ctx.neg('neg/sig/a-legacy-ek-pop', 'sig', ctx.typical['legacy-ek-pop']);
}

const AGE = () => ({ user_id: crypto.randomUUID(), valid_age: true, nsfw_auth: false, jurisdiction_obligation: 2,
  nonce: Buffer.from(rnd(32)).toString('hex'), timestamp: 1700000000, device_id: crypto.randomUUID(), client_version: '0.2.48' });
const BIND = () => ({ realm_id: crypto.randomUUID(), user_id: crypto.randomUUID(), device_id: crypto.randomUUID(),
  session_id: crypto.randomUUID(), challenge: Buffer.from(rnd(32)).toString('hex'), issued_at_ms: 1700000000123 });

async function signedAndTexts(ctx) {
  const sgn = (type, msg, dual) => ({ type, msg, sig_a: rnd(96), sig_b: dual ? rnd(96) : E0 });
  const t = ctx.typical;
  const sigB = `"${b64e(rnd(96))}"`;
  await ctx.pos('pos/signed/delegation', 'signed', encode('signed', sgn('delegation', t.delegation, true)));
  await ctx.pos('pos/signed/succession', 'signed', encode('signed', sgn('succession', t.succession, true)));
  await ctx.pos('pos/signed/device-status', 'signed', encode('signed', sgn('device-status', t['device-status'], false)));
  await ctx.neg('neg/signed/delegation-sig-b-empty', 'signed', encodeRaw('signed', sgn('delegation', t.delegation, true), { sig_b: '""' }));
  await ctx.neg('neg/signed/succession-sig-b-empty', 'signed', encodeRaw('signed', sgn('succession', t.succession, true), { sig_b: '""' }));
  await ctx.neg('neg/signed/status-sig-b-present', 'signed', encodeRaw('signed', sgn('status', t.status, false), { sig_b: sigB }));
  await ctx.neg('neg/signed/device-status-sig-b-present', 'signed',
    encodeRaw('signed', sgn('device-status', t['device-status'], false), { sig_b: sigB }));
  await ctx.neg('neg/signed/type-not-msg2', 'signed', encodeRaw('signed', sgn('status', t.status, false), { type: '"delegation"', sig_b: sigB }));
  await ctx.neg('neg/signed/type-result', 'signed', encodeRaw('signed', sgn('status', t.status, false),
    { type: '"result"', msg: `"${b64e(t.result)}"` }));
  const age = ageClaimV2Bytes(AGE());
  const bind = sessionBindBytes(BIND());
  await ctx.neg('neg/legacy-ek-pop/age-claim-text', 'legacy-ek-pop', age);
  await ctx.neg('neg/query/age-claim-text', 'query', age);
  await ctx.neg('neg/sig/session-bind-text', 'sig', bind);
  await ctx.pos('pos/query-resp/failure-form', 'query-resp', utf8(`["${PREFIX}",1,"query-resp","",[],"",[]]`));
}

async function ledger(ctx) {
  const dsv = await buildValues('device-set', TYPICAL);
  dsv.active = [await devString(MAX_SAFE)];
  await ctx.pos('pos/device-set/dev-319', 'device-set', encode('device-set', dsv));
  const [id, dk, dx] = dsv.active[0].split('.');
  await ctx.neg('neg/device-set/dev-320', 'device-set', encodeRaw('device-set', dsv, { active: `["${id}.${dk}.${dx}.10000000000000000"]` }));
  await ctx.neg('neg/device-set/dev-id-mismatch', 'device-set', encodeRaw('device-set', dsv, { active: `["${crypto.randomUUID()}.${dk}.${dx}.1"]` }));
  // §2.5 "IDs are pairwise distinct": two entries with one device id and one dsk,
  // differing only in mature_at_ms, are strictly ascending as strings (…5 < …6)
  // and each parses, so only the pairwise-distinct rule can refuse them.
  await ctx.neg('neg/device-set/duplicate-id', 'device-set',
    encodeRaw('device-set', { ...dsv, active: [`${id}.${dk}.${dx}.5`, `${id}.${dk}.${dx}.6`] }, {}));
  const rk = await nextPoint();
  const rk2 = await nextPoint();
  const d1 = rnd(48);
  const d2 = rnd(48);
  const base = { recovery_key: E0, recovery_bind_digest: E0, replacement_key: E0, replacement_bind_digest: E0, replacement_nb_ms: 0 };
  for (const [n, o] of [['pending-refresh', { recovery_key: rk, recovery_bind_digest: d1, replacement_key: rk2, replacement_bind_digest: d2, replacement_nb_ms: 5 }],
    ['pending-unbind', { recovery_key: rk, recovery_bind_digest: d1, replacement_bind_digest: d2, replacement_nb_ms: 5 }],
    ['pending-first-bind', { replacement_key: rk2, replacement_bind_digest: d2, replacement_nb_ms: 5 }],
    // The commonest state after a bind: a bound key, an empty replacement slot.
    ['bound-no-slot', { recovery_key: rk, recovery_bind_digest: d1 }]]) {
    await ctx.pos(`pos/device-set/${n}`, 'device-set', encode('device-set', { ...dsv, ...base, ...o }));
  }
  for (const [n, o] of [['key-without-digest', { recovery_key: rk }], ['digest-without-key', { recovery_bind_digest: d1 }],
    ['slot-digest-without-nb', { replacement_key: rk2, replacement_bind_digest: d2 }], ['nb-without-slot-digest', { replacement_nb_ms: 5 }],
    ['slot-key-without-digest', { replacement_key: rk2 }], ['unbind-without-bound-key', { replacement_bind_digest: d2, replacement_nb_ms: 5 }],
    ['refresh-to-bound-key', { recovery_key: rk, recovery_bind_digest: d1, replacement_key: rk, replacement_bind_digest: d2, replacement_nb_ms: 5 }],
    ['pending-in-active', { pending: dsv.active[0] }]]) {
    await ctx.neg(`neg/device-set/${n}`, 'device-set', encodeRaw('device-set', { ...dsv, ...base, ...o }, {}));
  }
  // §2.5 "pending is not in active" is by device id, not by the whole `dev` string.
  // The same device at another maturity, or with another (valid) dkx, is a different
  // string but the same device. Each pending below differs from active[0] in exactly
  // one position, so it is not a duplicate in active, it parses, and only the by-id
  // rule can refuse it.
  const activeMature = dsv.active[0].split('.')[3];
  let otherDkx = b64e(await nextPoint());
  while (otherDkx === dx) otherDkx = b64e(await nextPoint());
  await ctx.neg('neg/device-set/pending-same-id-other-maturity', 'device-set',
    encodeRaw('device-set', { ...dsv, ...base, pending: `${id}.${dk}.${dx}.1` }, {}));
  await ctx.neg('neg/device-set/pending-same-id-other-dkx', 'device-set',
    encodeRaw('device-set', { ...dsv, ...base, pending: `${id}.${dk}.${otherDkx}.${activeMature}` }, {}));

  const rb = await buildValues('recovery-bind', TYPICAL);
  const bindB = { ...rb, kind: 'bind', expires_at_ms: 0, target_digest: E0 };
  const cancelB = { ...rb, kind: 'cancel', expires_at_ms: 1700000660000, chain_seq: 0, chain_entry_digest: E0,
    binding_root_digest: E0, escrow_public_key: E0 };
  const unbindB = { ...rb, kind: 'unbind', recovery_key: E0, target_digest: E0, escrow_public_key: E0, expires_at_ms: 0 };
  await ctx.pos('pos/recovery-bind/bind', 'recovery-bind', encode('recovery-bind', bindB));
  await ctx.pos('pos/recovery-bind/cancel', 'recovery-bind', encode('recovery-bind', cancelB));
  await ctx.pos('pos/recovery-bind/unbind', 'recovery-bind', encode('recovery-bind', unbindB));
  const off = bindB.escrow_public_key.slice();
  off[96] ^= 1;
  await ctx.neg('neg/recovery-bind/escrow-equals-recovery-key', 'recovery-bind',
    encodeRaw('recovery-bind', { ...bindB, escrow_public_key: bindB.recovery_key }, {}));
  await ctx.neg('neg/recovery-bind/escrow-off-curve', 'recovery-bind', encodeRaw('recovery-bind', bindB, { escrow_public_key: `"${b64e(off)}"` }));
  await ctx.neg('neg/recovery-bind/kind-rebind', 'recovery-bind', encodeRaw('recovery-bind', bindB, { kind: '"rebind"' }));

  const full = { intent: encode('intent', { ...(await buildValues('intent', TYPICAL)), op: 'recover' }), sig_candidate: rnd(96),
    sig_recovery: rnd(96), ek_binding: ctx.typical['ek-binding'], ek_binding_sig: rnd(96),
    recovery_bind: encode('recovery-bind', bindB), recovery_bind_sig: rnd(96), device_intent: ctx.typical['device-intent'],
    sig_new_device: rnd(96) };
  const only = (keep, o = {}) => ({ ...Object.fromEntries(Object.entries(full).map(([k, x]) => [k, keep.includes(k) ? x : E0])), ...o });
  const cancelIntent = encode('intent', { ...(await buildValues('intent', TYPICAL)), op: 'cancel_pending' });
  await ctx.pos('pos/relay-recover/form-r', 'relay-recover', encode('relay-recover', full));
  await ctx.pos('pos/relay-recover/form-c', 'relay-recover', encode('relay-recover', only(['sig_recovery'], { intent: cancelIntent })));
  await ctx.pos('pos/relay-recover/form-b', 'relay-recover',
    encode('relay-recover', only(['sig_recovery'], { recovery_bind: encode('recovery-bind', cancelB) })));
  await ctx.neg('neg/relay-recover/c-plus-ek-binding', 'relay-recover',
    encodeRaw('relay-recover', only(['sig_recovery', 'ek_binding'], { intent: cancelIntent }), {}));
  await ctx.neg('neg/relay-recover/sig-recovery-only', 'relay-recover', encodeRaw('relay-recover', only(['sig_recovery']), {}));
  await ctx.neg('neg/relay-recover/r-without-device-intent', 'relay-recover', encodeRaw('relay-recover', { ...full, device_intent: E0 }, {}));
}

async function heads(ctx) {
  const realm = crypto.randomUUID();
  const account = crypto.randomUUID();
  const chain = (o) => encode('chain-head', { realm_id: realm, account_id: account, head_result: E0, fix: E0,
    active_ek_spki: E0, active_ek_generation: 0, pending_ek_spki: E0, pending_ek_generation: 0, pending_recovery_key: E0,
    seq_index: [], root_index: [], ek_index: [], recover_index: [], ...o });
  const devHead = async (ch, o) => encodeRaw('device-head', { realm_id: realm, account_id: account, self_device_id: '',
    last_device_result: E0, device_set: E0, chain_head_digest: await sha384(ch), admitted_by: [], secrets: [], ...o }, {});
  const pushHead = async (name, dh, ch, ok) => {
    let accepted = true;
    try {
      const v = await decode('device-head', dh);
      await decode('chain-head', ch);
      accepted = equalBytes(v.chain_head_digest, await sha384(ch));
    } catch (e) {
      if (!(e instanceof Malformed)) throw e;
      accepted = false;
    }
    if (accepted !== ok) throw new Error(`self-check: ${name}`);
    ctx.push({ name, type: 'device-head', bytes_b64: b64e(dh), input: { chain_head_b64: b64e(ch) }, expect: ok ? OK(dh) : BAD });
  };

  const genesis = chain({});
  await ctx.pos('pos/chain-head/genesis', 'chain-head', genesis);
  await pushHead('pos/device-head/genesis-monitor', await devHead(genesis, {}), genesis, true);
  await pushHead('pos/device-head/genesis-own', await devHead(genesis, { self_device_id: crypto.randomUUID() }), genesis, true);

  const root = await nextPoint();
  const { spki } = await ek();
  const seqRec = `${b64e(rnd(48))}.${b64e(rnd(48))}`;
  const rootRec = `${b64e(rnd(48))}.${b64e(root)}.continuity`;
  const recRec = `${MAX_SAFE}.${b64e(rnd(48))}`;
  const caps = chain({ head_result: ctx.typical.result, fix: ctx.typical.signed, active_ek_spki: spki, active_ek_generation: 3,
    pending_ek_spki: spki, pending_ek_generation: 4, pending_recovery_key: await nextPoint(),
    seq_index: [`${b64e(rnd(48))}.`, seqRec], root_index: [rootRec], ek_index: [rnd(48)],
    recover_index: [recRec, `10.${b64e(rnd(48))}`] });
  await ctx.pos('pos/chain-head/records-at-caps', 'chain-head', caps);
  const ct = text(caps);
  await ctx.neg('neg/chain-head/seq-record-over', 'chain-head', raw(ct.replace(`"${seqRec}"`, `"${seqRec}A"`)));
  await ctx.neg('neg/chain-head/root-record-over', 'chain-head', raw(ct.replace(`"${rootRec}"`, `"${rootRec}A"`)));
  await ctx.neg('neg/chain-head/recover-record-over', 'chain-head', raw(ct.replace(`"${recRec}"`, `"${recRec}A"`)));

  const adm = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
  const sec = `${b64e(rnd(48))}.rotate_root.${b64e(root)}.${b64e(spki)}`;
  const capsDh = await devHead(caps, { self_device_id: crypto.randomUUID(), last_device_result: ctx.typical['device-result'],
    device_set: ctx.typical['device-set'], admitted_by: [adm, `${crypto.randomUUID()}.`],
    secrets: [sec, `${b64e(rnd(48))}.rotate_ek..${b64e(spki)}`] });
  await pushHead('pos/device-head/records-at-caps', capsDh, caps, true);
  const dt = text(capsDh);
  await pushHead('neg/device-head/admitted-record-over', raw(dt.replace(`"${adm}"`, `"${adm}A"`)), caps, false);
  await pushHead('neg/device-head/secrets-record-over', raw(dt.replace(`"${sec}"`, `"${sec}A"`)), caps, false);
  await pushHead('neg/device-head/chain-head-digest-mismatch', await devHead(genesis, {}), caps, false);
  await pushHead('neg/device-head/extra-element', raw(dt.slice(0, -1) + ',""]'), caps, false);
}

async function primitives(ctx) {
  const prim = (name, type, input, expect) => ctx.push({ name, type, input, expect });
  const even = await pointWithParity(0);
  const odd = await pointWithParity(1);
  const h06 = even.slice();
  h06[0] = 0x06;
  const h07 = odd.slice();
  h07[0] = 0x07;
  const off = even.slice();
  off[96] ^= 1;
  for (const [n, b, ok] of [['valid', even, true], ['hybrid-06', h06, false], ['hybrid-07', h07, false], ['off-curve', off, false],
    ['compressed', concat([0x02], even.subarray(1, 49)), false], ['short', even.subarray(0, 96), false]]) {
    let accepted = true;
    try {
      await importP384(b);
    } catch {
      accepted = false;
    }
    if (accepted !== ok) throw new Error(`self-check: p384-point/${n}`);
    prim(`prim/p384-point/${n}`, 'p384-point', { point_b64: b64e(b) }, ok ? OK() : BAD);
  }

  const k = await ecKey(1);
  const pt = await pointAt(1);
  const msg = rnd(64);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, k.privateKey, msg));
  const hybridPt = pt.slice();
  hybridPt[0] = 0x06 | (pt[96] & 1);
  for (const [n, p, m, s, ok] of [['valid', pt, msg, sig, true], ['wrong-msg', pt, rnd(64), sig, false],
    ['95', pt, msg, sig.subarray(0, 95), false], ['97', pt, msg, concat(sig, [0]), false],
    ['der', await pointAt(0), utf8('der'), await derSig(), false], ['hybrid-point', hybridPt, msg, sig, false]]) {
    if ((await verifyP384(p, m, s)) !== ok) throw new Error(`self-check: p384-sig/${n}`);
    prim(`prim/p384-sig/${n}`, 'p384-sig', { point_b64: b64e(p), msg_b64: b64e(m), sig_b64: b64e(s) }, ok ? OK() : BADSIG);
  }
  // P1363 scalar range: r and s must lie in [1, n-1], and a high s is accepted (no low-s rule).
  const n384 = big(Buffer.from('ffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973', 'hex'));
  const be48 = (x) => new Uint8Array(Buffer.from(x.toString(16).padStart(96, '0'), 'hex'));
  const [sr, ss] = [sig.subarray(0, 48), big(sig.subarray(48))];
  const highS = be48(ss > n384 / 2n ? ss : n384 - ss);
  for (const [n, s, ok] of [['high-s', concat(sr, highS), true], ['r-zero', concat(be48(0n), be48(ss)), false],
    ['s-zero', concat(sr, be48(0n)), false], ['r-eq-n', concat(be48(n384), be48(ss)), false], ['s-eq-n', concat(sr, be48(n384)), false]]) {
    if ((await verifyP384(pt, msg, s)) !== ok) throw new Error(`self-check: p384-sig/${n}`);
    prim(`prim/p384-sig/${n}`, 'p384-sig', { point_b64: b64e(pt), msg_b64: b64e(msg), sig_b64: b64e(s) }, ok ? OK() : BADSIG);
  }

  const { kp, spki } = await ek();
  const pss = await subtle.importKey('pkcs8', new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey)),
    { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']); // in memory only, never written
  const pm = rnd(64);
  const ps = new Uint8Array(await subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, pss, pm));
  const ps20 = new Uint8Array(await subtle.sign({ name: 'RSA-PSS', saltLength: 20 }, pss, pm));
  for (const [n, m, s, ok] of [['valid', pm, ps, true], ['wrong-msg', rnd(64), ps, false], ['511', pm, ps.subarray(0, 511), false],
    ['salt-20', pm, ps20, false]]) {
    if ((await verifyLegacyPSS(spki, m, s)) !== ok) throw new Error(`self-check: pss-sig/${n}`);
    prim(`prim/pss-sig/${n}`, 'pss-sig', { spki_b64: b64e(spki), msg_b64: b64e(m), sig_b64: b64e(s) }, ok ? OK() : BADSIG);
  }

  // Two shapes that keep the 550-byte length. Go parses the first as the same key (x509
  // right-aligns the bit string), so only the re-marshal comparison refuses it; only a
  // modulus-size check refuses the second.
  const spkiAt = (at, want) => {
    if (!equalBytes(spki.subarray(at, at + want.length), new Uint8Array(want))) throw new Error(`self-check: spki[${at}..] is not ${want}`);
  };
  spkiAt(19, [0x03, 0x82, 0x02, 0x0f, 0x00, 0x30]);
  const unusedBits = spki.slice();
  unusedBits[23] = 0x01;
  for (let i = 24; i < 550; i++) unusedBits[i] = ((spki[i] << 1) | (i < 549 ? spki[i + 1] >> 7 : 0)) & 0xff;
  spkiAt(28, [0x02, 0x82, 0x02, 0x01, 0x00]);
  const modulus4097 = spki.slice();
  modulus4097[32] = 0x01;
  for (const [n, b] of [['valid', spki], ...(await badSpkis()), ['bitstring-unused-bits', unusedBits], ['modulus-4097', modulus4097]]) {
    const ok = n === 'valid';
    let web = true;
    try {
      await checkEkSpkiWebCrypto(b);
    } catch {
      web = false;
    }
    let tpl = true;
    try {
      checkEkSpkiTemplate(b);
    } catch {
      tpl = false;
    }
    if (web !== ok || tpl !== ok) throw new Error(`self-check: ek-spki/${n}`);
    prim(`prim/ek-spki/${n}`, 'ek-spki', { spki_b64: b64e(b) }, ok ? OK() : BAD);
  }

  for (const n of ['a', 'b']) {
    const dsk = await nextPoint();
    prim(`prim/device-id/${n}`, 'device-id', { dsk_b64: b64e(dsk) }, { ...OK(), device_id: await deviceId(dsk) });
    const acct = crypto.randomUUID();
    const pin = rnd(48);
    prim(`prim/safety-number/${n}`, 'safety-number', { account_id: acct, pin_digest_b64: b64e(pin) },
      { ...OK(), safety_number: await safetyNumber(acct, pin) });
  }
  prim('prim/safety-number/uppercase-account', 'safety-number', { account_id: crypto.randomUUID().toUpperCase(),
    pin_digest_b64: b64e(rnd(48)) }, { ...BAD, safety_number: '' });

  const age = AGE();
  prim('prim/age-claim-v2/valid', 'age-claim-v2', age, { ...OK(), text_b64: b64e(ageClaimV2Bytes(age)) });
  prim('prim/age-claim-v2/nonce-uppercase', 'age-claim-v2', { ...age, nonce: age.nonce.toUpperCase() }, BAD);
  // The timestamp bound is MaxSafeInt in both implementations, as for session-bind's issued_at_ms.
  const ageMax = { ...age, timestamp: Number.MAX_SAFE_INTEGER };
  prim('prim/age-claim-v2/timestamp-max-safe', 'age-claim-v2', ageMax, { ...OK(), text_b64: b64e(ageClaimV2Bytes(ageMax)) });
  prim('prim/age-claim-v2/timestamp-2pow53', 'age-claim-v2', { ...age, timestamp: 2 ** 53 }, BAD);
  const bind = BIND();
  prim('prim/session-bind-v1/valid', 'session-bind-v1', bind, { ...OK(), text_b64: b64e(sessionBindBytes(bind)) });
  prim('prim/session-bind-v1/short-challenge', 'session-bind-v1', { ...bind, challenge: bind.challenge.slice(1) }, BAD);
  const bindMax = { ...bind, issued_at_ms: Number.MAX_SAFE_INTEGER };
  prim('prim/session-bind-v1/issued-at-max-safe', 'session-bind-v1', bindMax, { ...OK(), text_b64: b64e(sessionBindBytes(bindMax)) });
  prim('prim/session-bind-v1/issued-at-2pow53', 'session-bind-v1', { ...bind, issued_at_ms: 2 ** 53 }, BAD);

  prim('prim/credential-epoch-digest/null', 'credential-epoch-digest', { epoch: 'e1', epoch_valid: false }, { ...OK(), digest_b64: '' });
  prim('prim/credential-epoch-digest/empty', 'credential-epoch-digest', { epoch: '', epoch_valid: true }, { ...OK(), digest_b64: '' });
  prim('prim/credential-epoch-digest/value', 'credential-epoch-digest', { epoch: 'e1', epoch_valid: true },
    { ...OK(), digest_b64: b64e(await credentialEpochDigest('e1', true)) });

  const recs = [0, 1, 2].map(() => ({ account_id: crypto.randomUUID(), legacy_ek_digest: rnd(48) }));
  const toInput = (rs) => ({ records: rs.map((r) => ({ account_id: r.account_id, legacy_ek_digest_b64: b64e(r.legacy_ek_digest) })) });
  prim('prim/population-digest/three', 'population-digest', toInput(recs), { ...OK(), digest_b64: b64e(await populationDigest(recs)) });
  prim('prim/population-digest/duplicate', 'population-digest', toInput([recs[0], recs[0]]), BAD);

  const tp = await nextPoint();
  prim('prim/tls-pin/a', 'tls-pin', { point_b64: b64e(tp) }, { ...OK(), digest_b64: b64e(await tlsPin(tp)) });

  // The ordered position names of every layout. A second implementation that decodes
  // and re-encodes through its own table round-trips itself whatever the order of two
  // same-kind rows (primary_a/primary_b, realm_id/account_id), so no byte-level vector
  // can see that swap; the names, in position order, can.
  for (const tag of Object.keys(LAYOUTS)) {
    prim(`prim/layout-fields/${tag}`, 'layout-fields', { layout: tag, fields: LAYOUTS[tag].map(([name]) => name) }, OK());
  }
}

// BUILDERS is ordered; PR-A2 appends its verification builders.
export const BUILDERS = [everyLayout, parsing, arraysAndEvidence, base64AndKeys, signedAndTexts, ledger, heads, primitives];

// resetDraw forgets everything a draw randomised, so the next buildVectors() is a new
// draw rather than the same key pool, EK and typical values placed differently.
function resetDraw() {
  keys.length = 0;
  pointSeq = 0;
  ekCache = undefined;
  badSpkiCache = undefined;
  typicalCache.clear();
  RUNTIME_ONLY.length = 0;
}

export async function buildVectors() {
  resetDraw();
  const ctx = makeCtx();
  for (const step of BUILDERS) await step(ctx);
  return ctx.out;
}

// ── 5. Public-mirror safety ──────────────────────────────────────────────────
//
// vectors.json lives under services/**, which the public mirror publishes, and the
// post-merge gate (scripts/public-mirror/publish-gates.sh) scans the tree with gitleaks
// 8.30.1 (GITLEAKS_VERSION, .github/workflows/publish-public-mirror.yml) and
// scripts/public-mirror/gitleaks-gate.toml (useDefault = true). The vectors are random
// public key material, so a draw can hold a base64 value that ends in a credential
// keyword ("Api", "key", ...) directly before the next quoted base64 value, and gitleaks'
// generic-api-key rule reads that pair as a credential. A tripped gate stops the mirror
// from publishing, and nothing before the merge runs it. mirrorUnsafe predicts the trip
// and main() refuses to write a draw it flags.
//
// A port of what gitleaks 8.30.1 does, read from the binary and measured against it:
//  - The rule. [[rules]] id = "generic-api-key" in the default config embedded in the
//    binary (`strings -n 1 "$(command -v gitleaks)"`; the same regex and entropy are in
//    config/gitleaks.toml of the gitleaks checkout pre-commit caches under
//    ~/.cache/pre-commit). The secret is the first non-empty capture group, and a match is
//    a finding when the Shannon entropy of that secret is above 3.5 (gitleaks skips
//    entropy <= 3.5) and the secret is not made only of letters, '_', '.' and '-' (the
//    rule's first allowlist, `^[a-zA-Z_.-]+$`). The allowlist is ported because it is not
//    optional: the file holds identifier-shaped pairs on purpose (the layout-fields
//    vectors list field names such as "rsk_public_keys","cak_public_keys"), and without it
//    every draw would be flagged.
//  - The decoder. gitleaks scans the text as written, then up to --max-decode-depth
//    (default 5) more times, each time after replacing the runs it can decode with their
//    decoded text. That is how the gate sees inside the base64 messages in bytes_b64. The
//    binary's decoder is not readable from here, so everything below was MEASURED on 8.30.1
//    with crafted files (a pair that is visible only once decoded; four samples of each
//    shape, with a control that differs only in the property named):
//      decoded:     a run of /[\w/+-]{16,}={0,2}/ whose bytes decode to 9..126 when it is
//                   standard-alphabet base64 that is padded or needs no padding, or
//                   URL-safe base64 without padding (or with none needed); a hit wrapped
//                   in base64 up to five times; runs up to 1 MiB (no length limit).
//      not decoded: standard base64 whose padding was stripped and that holds '+' or '/';
//                   URL-safe base64 with padding that holds '-' or '_'; a run with none of
//                   [0-9+/_-] (letters only; the same run with a digit-bearing tail
//                   decodes); any decoded text with a byte outside 9..126 (NUL, 0x01..0x08,
//                   DEL, anything non-ASCII); a hit wrapped six or more times.
//      also there:  hex (either case), percent-encoding and \uXXXX or U+XXXX escapes are
//                   decoded too (not \U0000XXXX, \xXX or &#xXX;).
//    The port models only the base64 decoder, and it differs from the binary in two
//    directions. (1) decodeBase64Runs below uses Buffer, which reads both alphabets with or
//    without padding in any mix and has no [0-9+/_-] rule, so it decodes some runs the
//    binary leaves encoded. That mostly adds text the gate never scans, which flags more.
//    It could hide a hit only where such a run is itself the secret of a pair completed in
//    the same pass, and that needs random key material to decode to printable ASCII (about
//    1e-16 for a 48-byte digest). (2) The hex, percent and unicode decoders are omitted, so
//    a pair hidden in one of those encodings would be missed. Neither difference showed up:
//    over 120 raw draws the real gate tripped on 14 and the port flagged the same 14, and
//    the committed file is flagged by neither. This is a measurement of one binary, not a
//    proof: a gitleaks upgrade (GITLEAKS_VERSION) must re-run the measurements above.
//  - Not ported, because each only ever suppresses a finding, so leaving it out makes the
//    predicate flag more and never less: the rule's other allowlist (a regex over the whole
//    match) and its stopwords, and the allowlists in gitleaks-gate.toml. A flagged draw
//    costs a redraw, nothing else.
// RE2 has the (?-i:[Aa]pi|API) group that JavaScript cannot express inside an /i regex,
// so no flag is used: every keyword is spelled case-insensitively and "Api", "api" and
// "API" stay the only spellings of that one.
const ci = (w) => [...w].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join('');
const GL_KEYWORDS = [ci('access'), ci('auth'), '(?:Api|api|API)', ci('credential'), ci('creds'), ci('key'),
  `${ci('passw')}(?:${ci('or')})?${ci('d')}`, ci('secret'), ci('token')];
const GL_GENERIC_API_KEY = new RegExp(
  String.raw`[\w.-]{0,50}?(?:${GL_KEYWORDS.join('|')})(?:[ \t\w.-]{0,20})[\s'"]{0,3}` +
  String.raw`(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)[\x60'"\s=]{0,5}` +
  String.raw`([\w.=-]{10,150}|[a-zA-Z0-9][a-zA-Z0-9+/]{11,}={0,3})(?:[\x60'"\s;]|\\[nrNR]|$)`, 'g');
const GL_ENTROPY = 3.5;
const GL_SECRET_ALLOWLIST = /^[a-zA-Z_.-]+$/;
const GL_MAX_DECODE_DEPTH = 5;
const GL_B64_RUN = /[\w/+-]{16,}={0,2}/g;

function shannon(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function genericApiKeyFinding(text) {
  for (const m of text.matchAll(GL_GENERIC_API_KEY)) {
    // 1e-9 only guards float noise at the threshold; it can only flag more.
    if (shannon(m[1]) > GL_ENTROPY - 1e-9 && !GL_SECRET_ALLOWLIST.test(m[1])) return true;
  }
  return false;
}

// Buffer's base64 reader is MORE lenient than the binary's (see section 5's header for
// the shapes 8.30.1 leaves encoded), so this decodes some runs the gate does not.
function decodeBase64Runs(text) {
  return text.replace(GL_B64_RUN, (run) => {
    const bytes = Buffer.from(run, 'base64');
    return bytes.length > 0 && bytes.every((b) => b >= 9 && b <= 126) ? bytes.toString('latin1') : run;
  });
}

// mirrorUnsafe reports whether the public-mirror gate would flag jsonText, the serialized
// vectors file.
export function mirrorUnsafe(jsonText) {
  let text = jsonText;
  for (let pass = 0; pass <= GL_MAX_DECODE_DEPTH; pass++) {
    if (genericApiKeyFinding(text)) return true;
    const next = decodeBase64Runs(text);
    if (next === text) return false;
    text = next;
  }
  return false;
}

export const MAX_DRAWS = 25;

export async function renderVectorFile(vectors) {
  const body = `${vectors.map((v) => JSON.stringify(v)).join(',\n')}\n]}\n`;
  return `{"generator_sha384":"${await generatorDigest()}","vectors_sha384":"${await vectorsDigest(body)}",` +
    `"vectors":[\n${body}`;
}

// buildSafeVectorFile draws until the public-mirror gate would pass the file. It builds
// and returns the text and never writes; main() writes. `unsafe` is injectable so a test
// can drive the loop without waiting for a real flagged draw.
export async function buildSafeVectorFile(maxDraws = MAX_DRAWS, unsafe = mirrorUnsafe) {
  for (let draw = 1; draw <= maxDraws; draw++) {
    const vectors = await buildVectors();
    const body = await renderVectorFile(vectors);
    if (!unsafe(body)) return { body, count: vectors.length, draws: draw };
    console.error(`draw ${draw} of ${maxDraws} would trip the public-mirror secret scan; drawing again`);
  }
  throw new Error(`${maxDraws} draws in a row would trip the public-mirror secret scan (mirrorUnsafe); ` +
    'a rule in the generator, not bad luck, is putting a credential-shaped pair in the file');
}

async function main(argv) {
  if (argv.includes('--check')) {
    await checkDrift();
    return;
  }
  const { body, count, draws } = await buildSafeVectorFile();
  writeFileSync(VECTORS_PATH, body);
  console.error(`wrote ${count} vectors in ${draws} draw(s); runtime-only boundaries: ${RUNTIME_ONLY.join(', ') || 'none'}`);
}

// Node real-paths the main module for import.meta.url but not process.argv[1], so
// comparing the two verbatim is false when the invocation path holds a symlinked
// directory (macOS /tmp, a checkout behind a link) and main() would silently never
// run: the pre-commit drift check would exit 0 without checking. Compare real paths.
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false; // argv[1] is not a file, so this module was imported, not run
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
