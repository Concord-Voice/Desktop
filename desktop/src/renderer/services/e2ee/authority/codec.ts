// The account-key authority contract codec, protocol v1 (#2553 DoR §2.3, §2.5,
// §2.6, §2.12, §2.22). A port of Concord-Voice/Hosted
// scripts/authority-vectors/gen.mjs §1–2. Class F: frozen; the committed
// vectors decide every byte, cap and refusal.
//
// A message is a JSON array `["concord-account-authority",1,<tag>,…positions]`
// over the EN2 alphabet. encode() validates every position and writes; decode()
// parses, validates and requires that the value re-encodes to the same bytes.

import { b64d, b64e, equalBytes, utf8 } from './bytes';
import { Malformed } from './errors';
import {
  checkDevShape,
  checkEkSpkiTemplate,
  checkPoint,
  isUUID,
  isUUIDv4,
  MAX_SAFE,
  parseDev,
  parseU,
} from './primitives';

export { Malformed };

export const PREFIX = 'concord-account-authority';

const S_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:/+=-';
const S_SET = new Set(S_ALPHABET);
const EN2 = new Set([...S_ALPHABET, '"', ',', '[', ']'].map((c) => c.charCodeAt(0)));

type StrCheck =
  | 'version'
  | 'legacyRow'
  | 'seqRec'
  | 'rootRec'
  | 'recoverRec'
  | 'admittedRec'
  | 'secretsRec'
  | 'dev';

interface Opt {
  empty?: boolean;
}
type StrKind = Opt &
  (
    | { t: 's'; max: number; chk?: StrCheck }
    | { t: 's36' }
    | { t: 's36v4' }
    | { t: 'e'; vals: readonly string[] }
  );
type UKind = Opt & { t: 'u'; min: number; max: number };
type BinKind = Opt & {
  t: 'b';
  sizes?: number[];
  upTo?: number;
  chk?: 'point' | 'ekspki';
  hold?: string;
};
type ListKind = Opt & { t: 'a' | 'l'; elem: StrKind | BinKind; min: number; max: number };
export type Kind = StrKind | UKind | BinKind | ListKind;

export type Value = string | number | Uint8Array | (string | Uint8Array)[];
export type Values = Record<string, Value>;

const S = (max: number, chk?: StrCheck): StrKind => ({ t: 's', max, chk });
const S36: StrKind = { t: 's36' };
const S36V4: StrKind = { t: 's36v4' };
const U: UKind = { t: 'u', min: 0, max: MAX_SAFE };
const U1: UKind = { t: 'u', min: 1, max: MAX_SAFE };
const U01: UKind = { t: 'u', min: 0, max: 1 };
const B = (n: number, chk?: 'point' | 'ekspki'): BinKind => ({ t: 'b', sizes: [n], chk });
const BONE = (...sizes: number[]): BinKind => ({ t: 'b', sizes });
const BUP = (n: number, hold?: string): BinKind => ({ t: 'b', upTo: n, hold });
const E = (...vals: string[]): StrKind => ({ t: 'e', vals });
const A = (elem: StrKind | BinKind, min: number, max: number): ListKind => ({
  t: 'a',
  elem,
  min,
  max,
});
const L = (elem: StrKind | BinKind, min: number, max: number): ListKind => ({
  t: 'l',
  elem,
  min,
  max,
});
const opt = <K extends Kind>(k: K): K => ({ ...k, empty: true });
const INF = Infinity;
const P97 = B(97, 'point');
const EKSPKI = B(550, 'ekspki');
const DEV = S(319, 'dev');
const D48 = B(48);
const D48o = opt(B(48));
const SIG = B(96);
const SIGo = opt(B(96));

// ── Closed sets (DoR §2.5, §2.6, §2.12, §2.22, §3.3) ─────────────────────────

const PUBLISHED_OPS = [
  'cancel_pending',
  'enroll_existing',
  'enroll_new',
  'erase',
  'recover',
  'replace_root',
  'revoke_root',
  'rotate_ek',
  'rotate_root',
  'suspend',
  'unsuspend',
];
const DEVICE_OPS = [
  'add_device',
  'bind_recovery',
  'cancel_recovery_bind',
  'enroll_existing',
  'enroll_new',
  'recover',
  'replace_root',
  'rotate_ek',
  'rotate_root',
  'unsuspend',
];
const SCOPE = [...PUBLISHED_OPS, 'add_device', 'bind_recovery', 'cancel_recovery_bind', 'status'];
const STATES = ['absent', 'active', 'suspended', 'pending', 'disputed', 'erased'];
const PRIOR = ['', 'absent', 'active', 'suspended'];
const ASSURANCE = ['', 'initial', 'continuity', 'recovery', 'unverified'];
const SEGMENT = ['initial', 'continuity', 'recovery', 'unverified'];
const SUSPENDERS = ['operator', 'user'];
const ACTORS = ['operator', 'restore', 'user'];
const ROLES = [
  'actor-device',
  'candidate',
  'current-root',
  'new-device',
  'operator',
  'recovery-key',
];
export const FACTORS = [
  'admin-webauthn',
  'backup-code',
  'device-key',
  'email',
  'email-backup',
  'erasure-list',
  'passkey',
  'password',
  'recovery-key',
  'registration',
  'session',
  'sso',
  'totp',
  'webauthn',
];
const BIND_KINDS = ['bind', 'cancel', 'unbind'];
const BIND_WAITS = ['', 'delta', 'now', 'replace'];
const SIGNED_TYPES = ['delegation', 'device-status', 'status', 'succession'];
const SECRETS_OPS = ['add_device', 'rotate_ek', 'rotate_root'];
const REFUSALS = [
  'authz_out_of_window',
  'device_key_bound',
  'device_limit',
  'device_too_new',
  'device_unknown',
  'ek_generation',
  'ek_mismatch',
  'ek_reused',
  'expired',
  'expiry_out_of_range',
  'held',
  'in_population',
  'insufficient_authorization',
  'legacy_mismatch',
  'malformed_for_op',
  'policy_disabled',
  'predecessor_mismatch',
  'recovery_key_bound',
  'recovery_key_unbound',
  'root_bound_elsewhere',
  'root_revoked',
  'root_reused',
  'stale_device_seq',
  'stale_head',
  'stale_recovery_gen',
  'stale_seq',
  'wrong_state',
];
const ERRORS = [
  'malformed',
  'bad_signature',
  'bad_authz',
  'request_conflict',
  'too_large',
  'store',
  'signer',
  'clock',
  'reconcile',
  'not_sealed',
  'busy',
  'not_ready',
  'not_leader',
  'replication',
  'disk',
];

// ── Layouts: position order is the wire order ────────────────────────────────

export const LAYOUTS: Record<string, readonly (readonly [string, Kind])[]> = {
  intent: [
    ['realm_id', S36],
    ['account_id', S36],
    ['request_id', S36V4],
    ['op', E(...PUBLISHED_OPS)],
    ['expires_at_ms', U1],
    ['expected_seq', U],
    ['expected_recovery_gen', U],
    ['expected_head_digest', D48o],
    ['predecessor_root_digest', D48o],
    ['candidate_root', opt(P97)],
    ['ek_binding_digest', D48o],
    ['legacy_ek_digest', D48o],
    ['device_intent_digest', D48o],
    ['recovery_bind_digest', D48o],
  ],
  sig: [
    ['role', E(...ROLES)],
    ['digest', D48],
  ],
  'legacy-ek-pop': [
    ['realm_id', S36],
    ['account_id', S36],
    ['intent_digest', D48],
    ['legacy_ek_digest', D48],
  ],
  'ek-binding': [
    ['realm_id', S36],
    ['account_id', S36],
    ['root_digest', D48],
    ['ek_generation', U1],
    ['ek_alg', E('rsa-oaep-4096-sha256')],
    ['ek_public_key', EKSPKI],
  ],
  'cp-authz': [
    ['realm_id', S36],
    ['account_id', S36],
    ['request_id', S36V4],
    ['intent_digest', D48],
    ['actor', E(...ACTORS)],
    ['asserted_at_ms', U1],
    ['evidence_digest', D48],
  ],
  'cp-evidence': [
    ['request_id', S36V4],
    ['factors', A(E(...FACTORS), 0, 14)],
    ['mfa_enrolled', U01],
    ['password_login', U01],
    ['recovery_window_clear', U01],
    ['operator_assisted', U01],
    ['credential_epoch_digest', D48o],
    ['evidence_salt', B(32)],
  ],
  result: [
    ['realm_id', S36],
    ['account_id', S36],
    ['request_id', S36V4],
    ['intent_digest', D48],
    ['cp_authz_digest', D48],
    ['op', E(...PUBLISHED_OPS)],
    ['seq', U1],
    ['state', E(...STATES)],
    ['prior_state', E(...PRIOR)],
    ['suspended_by', A(E(...SUSPENDERS), 0, 2)],
    ['active_root', opt(P97)],
    ['root_revoked', U01],
    ['ek_binding_digest', D48o],
    ['pending_root', opt(P97)],
    ['pending_ek_binding_digest', D48o],
    ['legacy_ek_digest', D48o],
    ['legacy_pin_revoked', U01],
    ['prev_entry_digest', D48o],
    ['recovery_gen', U],
    ['activation_not_before_ms', U],
    ['assurance', E(...ASSURANCE)],
    ['issued_at_ms', U],
    ['delegation_gen', U],
    ['delegation_serial', U1],
  ],
  status: [
    ['realm_id', S36],
    ['account_id', S36],
    ['seq', U],
    ['head_entry_digest', D48o],
    ['state', E(...STATES)],
    ['prior_state', E(...PRIOR)],
    ['suspended_by', A(E(...SUSPENDERS), 0, 2)],
    ['active_root_digest', D48o],
    ['root_revoked', U01],
    ['ek_binding_digest', D48o],
    ['pending_root_digest', D48o],
    ['pending_ek_binding_digest', D48o],
    ['legacy_ek_digest', D48o],
    ['legacy_pin_revoked', U01],
    ['activation_not_before_ms', U],
    ['held', U01],
    ['as_of_ms', U],
    ['valid_until_ms', U],
    ['delegation_gen', U],
    ['delegation_serial', U1],
  ],
  query: [
    ['realm_id', S36],
    ['account_id', S36],
    ['signer_digest', D48],
    ['issued_at_ms', U],
    ['nonce', B(16)],
    ['after_dseq', U],
  ],
  delegation: [
    ['realm_id', S36],
    ['serial', U1],
    ['min_valid_serial', U],
    ['product_root_gen', U],
    ['rsk_public_keys', A(P97, 1, 4)],
    ['cak_public_keys', A(P97, 1, 4)],
    ['operator_public_keys', A(P97, 0, 4)],
    ['authority_tls_keys', A(P97, 1, 8)],
    ['cp_tls_pins', A(D48, 1, 8)],
    ['not_before_ms', U],
    ['not_after_ms', U],
    ['scope', A(E(...SCOPE), 1, 15)],
    ['accepted_versions', A(S(4, 'version'), 1, 8)],
    ['tau_ms', U],
    ['delta_ms', U],
    ['g_ms', U],
    ['cutover_at_ms', U],
  ],
  succession: [
    ['realm_id', S36],
    ['prev_root_gen', U],
    ['new_root_gen', U],
    ['new_primary_a', P97],
    ['new_primary_b', P97],
    ['new_recovery_a', P97],
    ['new_recovery_b', P97],
  ],
  anchors: [
    ['realm_id', S36],
    ['primary_a', P97],
    ['primary_b', P97],
    ['recovery_a', P97],
    ['recovery_b', P97],
  ],
  signed: [
    ['type', E(...SIGNED_TYPES)],
    ['msg', BUP(4096)],
    ['sig_a', SIG],
    ['sig_b', SIGo],
  ],
  statuses: [['items', L(BUP(6144, 'signed'), 0, 500)]],
  trust: [['items', L(BUP(6144, 'signed'), 1, 256)]],
  bundle: [
    ['intent', BUP(2048, 'intent')],
    ['sig_candidate', SIGo],
    ['sig_current_root', SIGo],
    ['sig_operator', SIGo],
    ['sig_recovery', SIGo],
    ['legacy_pop_sig', opt(B(512))],
    ['legacy_spki', opt(EKSPKI)],
    ['ek_binding', opt(BUP(2048, 'ek-binding'))],
    ['ek_binding_sig', SIGo],
    ['recovery_bind', opt(BUP(1024, 'recovery-bind'))],
    ['recovery_bind_sig', SIGo],
    ['cp_authz', BUP(1024, 'cp-authz')],
    ['cp_authz_sig', SIGo],
    ['result', BUP(4096, 'result')],
    ['result_sig', SIG],
    ['held_status', opt(BUP(6144, 'signed'))],
  ],
  history: [
    ['account_id', S36],
    ['bundles', L(BUP(32768, 'bundle'), 0, 200)],
  ],
  relay: [
    ['intent', BUP(2048, 'intent')],
    ['sig_current_root', SIGo],
    ['legacy_pop_sig', opt(B(512))],
    ['legacy_spki', opt(EKSPKI)],
  ],
  'query-req': [
    ['query', BUP(1024, 'query')],
    ['query_sig', BONE(96, 512)],
    ['legacy_spki', opt(EKSPKI)],
  ],
  'query-resp': [
    ['status', opt(BUP(6144, 'signed'))],
    ['bundles', L(BUP(32768, 'bundle'), 0, 16)],
    ['device_status', opt(BUP(2048, 'signed'))],
    ['device_bundles', L(BUP(8192, 'device-bundle'), 0, 16)],
  ],
  'device-set': [
    ['realm_id', S36],
    ['account_id', S36],
    ['active', A(DEV, 0, 10)],
    ['pending', opt(DEV)],
    ['recovery_key', opt(P97)],
    ['recovery_bind_digest', D48o],
    ['replacement_key', opt(P97)],
    ['replacement_bind_digest', D48o],
    ['replacement_nb_ms', U],
  ],
  'device-intent': [
    ['realm_id', S36],
    ['account_id', S36],
    ['request_id', S36V4],
    ['op', E(...DEVICE_OPS)],
    ['salt', B(32)],
    ['expires_at_ms', U],
    ['expected_seq', U],
    ['expected_head_digest', D48o],
    ['expected_dseq', U],
    ['expected_device_head', D48o],
    ['actor_device_id', opt(S36V4)],
    ['new_device_id', opt(S36V4)],
    ['new_device_dsk', opt(P97)],
    ['new_device_dkx', opt(P97)],
    ['removed_device_ids', A(S36V4, 0, 9)],
    ['recovery_bind_digest', D48o],
    ['bind_wait', E(...BIND_WAITS)],
  ],
  'device-result': [
    ['realm_id', S36],
    ['account_id', S36],
    ['request_id', S36V4],
    ['device_intent_digest', D48],
    ['cp_authz_digest', D48o],
    ['op', E(...DEVICE_OPS)],
    ['dseq', U1],
    ['prev_device_entry_digest', D48o],
    ['chain_seq', U1],
    ['chain_entry_digest', D48],
    ['device_set_digest', D48],
    ['issued_at_ms', U],
    ['delegation_gen', U],
    ['delegation_serial', U1],
  ],
  'device-status': [
    ['realm_id', S36],
    ['account_id', S36],
    ['chain_seq', U],
    ['chain_head_digest', D48o],
    ['dseq', U],
    ['device_head_digest', D48o],
    ['device_set_digest', D48],
    ['as_of_ms', U],
    ['valid_until_ms', U],
    ['delegation_gen', U],
    ['delegation_serial', U1],
  ],
  'device-bundle': [
    ['device_intent', opt(BUP(2048, 'device-intent'))],
    ['sig_root', SIGo],
    ['sig_actor', SIGo],
    ['sig_new_device', SIGo],
    ['recovery_bind', opt(BUP(1024, 'recovery-bind'))],
    ['sig_recovery', SIGo],
    ['sig_recovery_prior', SIGo],
    ['cp_authz', opt(BUP(1024, 'cp-authz'))],
    ['cp_authz_sig', SIGo],
    ['device_result', BUP(1024, 'device-result')],
    ['device_result_sig', SIG],
  ],
  'device-history': [
    ['account_id', S36],
    ['bundles', L(BUP(8192, 'device-bundle'), 0, 16)],
  ],
  'recovery-bind': [
    ['realm_id', S36],
    ['account_id', S36],
    ['request_id', S36V4],
    ['kind', E(...BIND_KINDS)],
    ['expires_at_ms', U],
    ['recovery_key', opt(P97)],
    ['target_digest', D48o],
    ['chain_seq', U],
    ['chain_entry_digest', D48o],
    ['binding_root_digest', D48o],
    ['escrow_public_key', opt(P97)],
  ],
  'device-wrap': [
    ['realm_id', S36],
    ['account_id', S36],
    ['recipient_device_id', S36V4],
    ['device_entry_digest', D48],
    ['epk', P97],
    ['nonce', B(12)],
    ['ct', BUP(4096)],
  ],
  'device-secrets': [
    ['root_pkcs8', opt(BUP(256))],
    ['ek_pkcs8', BUP(2600)],
  ],
  'relay-recover': [
    ['intent', opt(BUP(2048, 'intent'))],
    ['sig_candidate', SIGo],
    ['sig_recovery', SIG],
    ['ek_binding', opt(BUP(2048, 'ek-binding'))],
    ['ek_binding_sig', SIGo],
    ['recovery_bind', opt(BUP(1024, 'recovery-bind'))],
    ['recovery_bind_sig', SIGo],
    ['device_intent', opt(BUP(2048, 'device-intent'))],
    ['sig_new_device', SIGo],
  ],
  submit: [
    ['intent', BUP(2048, 'intent')],
    ['sig_candidate', SIGo],
    ['sig_current_root', SIGo],
    ['sig_operator', SIGo],
    ['sig_recovery', SIGo],
    ['legacy_pop_sig', opt(B(512))],
    ['legacy_spki', opt(EKSPKI)],
    ['ek_binding', opt(BUP(2048, 'ek-binding'))],
    ['ek_binding_sig', SIGo],
    ['recovery_bind', opt(BUP(1024, 'recovery-bind'))],
    ['recovery_bind_sig', SIGo],
    ['cp_authz', BUP(1024, 'cp-authz')],
    ['cp_authz_sig', SIG],
    ['cp_evidence', BUP(1024, 'cp-evidence')],
    ['device_intent', opt(BUP(2048, 'device-intent'))],
    ['sig_actor', SIGo],
    ['sig_new_device', SIGo],
  ],
  'import-item': [
    ['bundle', opt(BUP(32768, 'bundle'))],
    ['device_bundle', opt(BUP(8192, 'device-bundle'))],
    ['cp_evidence', opt(BUP(1024, 'cp-evidence'))],
  ],
  'import-batch': [['items', L(BUP(56320, 'import-item'), 1, 64)]],
  'legacy-batch': [['rows', A(S(101, 'legacyRow'), 1, 8192)]],
  committed: [
    ['result', BUP(4096, 'result')],
    ['result_sig', SIG],
    ['device_result', opt(BUP(1024, 'device-result'))],
    ['device_result_sig', SIGo],
  ],
  refused: [
    ['request_id', S36V4],
    ['code', E(...REFUSALS)],
  ],
  error: [['code', E(...ERRORS)]],
  head: [
    ['status', BUP(6144, 'signed')],
    ['latest_bundle', opt(BUP(32768, 'bundle'))],
    ['device_status', BUP(2048, 'signed')],
  ],
  'status-req': [['account_ids', A(S36, 1, 500)]],
  'hold-req': [['bundles', L(BUP(32768, 'bundle'), 1, 16)]],
  'pending-heads': [
    ['account_ids', A(S36, 0, 500)],
    ['next', opt(S36)],
  ],
  signer: [
    ['realm_id', S36],
    ['product_root_gen', U],
    ['delegation_serial', U1],
    ['restore_epoch', U],
    ['reconciled', U01],
    ['max_commit_id', U],
    ['held_count', U],
    ['legacy_sealed', U01],
    ['population_digest', D48o],
    ['tick_age_s', U],
    ['cancel_unavailable_ms', U],
    ['extension_cap_ms', U],
    ['n_cancel_ms', U],
    ['v_ms', U],
    ['role', E('leader', 'standby')],
    ['rsk_digest', D48],
    ['disk_ready', U01],
    ['replication_required', U01],
    ['replication_ready', U01],
    ['archive_ok', U01],
    ['clock_synced', U01],
    ['submit_layouts', A(S(16), 1, 8)],
    ['trust', BUP(2097152, 'trust')],
  ],
  'device-submit': [
    ['device_intent', opt(BUP(2048, 'device-intent'))],
    ['sig_root', SIGo],
    ['sig_actor', SIGo],
    ['sig_new_device', SIGo],
    ['recovery_bind', opt(BUP(1024, 'recovery-bind'))],
    ['sig_recovery', SIGo],
    ['sig_recovery_prior', SIGo],
    ['cp_authz', BUP(1024, 'cp-authz')],
    ['cp_authz_sig', SIG],
    ['cp_evidence', BUP(1024, 'cp-evidence')],
  ],
  'device-committed': [['device_bundle', BUP(8192, 'device-bundle')]],
  'chain-head': [
    ['realm_id', S36],
    ['account_id', S36],
    ['head_result', opt(BUP(4096, 'result'))],
    ['fix', opt(BUP(6144, 'signed'))],
    ['active_ek_spki', opt(EKSPKI)],
    ['active_ek_generation', U],
    ['pending_ek_spki', opt(EKSPKI)],
    ['pending_ek_generation', U],
    ['pending_recovery_key', opt(P97)],
    ['seq_index', L(S(129, 'seqRec'), 0, INF)],
    ['root_index', A(S(208, 'rootRec'), 0, INF)],
    ['ek_index', A(D48, 0, INF)],
    ['recover_index', A(S(81, 'recoverRec'), 0, INF)],
  ],
  'device-head': [
    ['realm_id', S36],
    ['account_id', S36],
    ['self_device_id', opt(S36V4)],
    ['last_device_result', opt(BUP(1024, 'device-result'))],
    ['device_set', opt(BUP(4608, 'device-set'))],
    ['chain_head_digest', D48],
    ['admitted_by', A(S(73, 'admittedRec'), 0, 11)],
    ['secrets', L(S(946, 'secretsRec'), 0, INF)],
  ],
};

export const CAPS: Record<string, number> = {
  anchors: 1024,
  signed: 6144,
  'device-set': 4608,
  'device-wrap': 6144,
  'device-intent': 2048,
  'device-bundle': 8192,
  'device-history': 180224,
  'recovery-bind': 1024,
  'relay-recover': 10278,
  'device-result': 1024,
  'device-secrets': 4080,
  trust: 2097152,
  'chain-head': 16777216,
  'device-head': 16777216,
};

// ── Caps: an explicit cap, else the longest encoding the layout admits ──────

const b64Len = (n: number): number => Math.ceil(n / 3) * 4;

function kmax(k: Kind): number {
  switch (k.t) {
    case 's':
      return k.max + 2;
    case 's36':
    case 's36v4':
      return 38;
    case 'u':
      return String(k.max).length;
    case 'b':
      return b64Len(k.upTo ?? Math.max(...(k.sizes ?? [0]))) + 2;
    case 'e':
      return Math.max(...k.vals.map((v) => v.length)) + 2;
    default:
      if (k.max === INF) return INF;
      return k.max === 0 ? 2 : 2 + k.max * kmax(k.elem) + k.max - 1;
  }
}

export function maxLen(tag: string): number {
  let n = `["${PREFIX}",1,"${tag}"]`.length;
  for (const [, k] of LAYOUTS[tag]) n += 1 + kmax(k);
  return n;
}

export const capOf = (tag: string): number => CAPS[tag] ?? maxLen(tag);

// ── Position rules ──────────────────────────────────────────────────────────

function parts(s: string, n: number): string[] {
  const p = s.split('.');
  if (p.length !== n) throw new Malformed('record parts');
  return p;
}

function exact(s: string, n: number): void {
  if (b64d(s).length !== n) throw new Malformed('record digest');
}

// Synchronous extra string rules. `dev` also needs DeviceID (async), which
// decode checks; encode checks only the shape.
const STRCHK: Record<StrCheck, (s: string) => void> = {
  version: (s) => {
    if (!/^[1-9]\d{0,3}$/.test(s)) throw new Malformed('version');
  },
  legacyRow: (s) => {
    const p = parts(s, 2);
    if (!isUUID(p[0])) throw new Malformed('legacy row');
    exact(p[1], 48);
  },
  seqRec: (s) => {
    const p = parts(s, 2);
    exact(p[0], 48);
    if (p[1] !== '') exact(p[1], 48);
  },
  rootRec: (s) => {
    const p = parts(s, 3);
    exact(p[0], 48);
    checkPoint(b64d(p[1]));
    if (!SEGMENT.includes(p[2])) throw new Malformed('root record assurance');
  },
  recoverRec: (s) => {
    const p = parts(s, 2);
    parseU(p[0]);
    exact(p[1], 48);
  },
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
  dev: checkDevShape,
};

function checkStr(k: StrKind, s: unknown): asserts s is string {
  if (typeof s !== 'string') throw new Malformed('not a string');
  if (s === '') {
    if (k.empty || (k.t === 'e' && k.vals.includes(''))) return;
    throw new Malformed('empty');
  }
  switch (k.t) {
    case 's':
      if (s.length > k.max || ![...s].every((c) => S_SET.has(c))) throw new Malformed('s');
      if (k.chk) STRCHK[k.chk](s);
      return;
    case 's36':
      if (!isUUID(s)) throw new Malformed('s36');
      return;
    case 's36v4':
      if (!isUUIDv4(s)) throw new Malformed('s36v4');
      return;
    case 'e':
      if (!k.vals.includes(s)) throw new Malformed('enum');
  }
}

function checkBin(k: BinKind, b: Uint8Array): void {
  const ok = k.sizes ? k.sizes.includes(b.length) : b.length >= 1 && b.length <= (k.upTo ?? 0);
  if (!ok) throw new Malformed('b size');
  if (k.chk === 'point') checkPoint(b);
  if (k.chk === 'ekspki') checkEkSpkiTemplate(b);
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function asBytes(x: unknown, name: string): Uint8Array {
  if (!(x instanceof Uint8Array)) throw new Malformed(`${name} not bytes`);
  return x;
}

function writeValue(k: Kind, x: unknown, name: string): string {
  switch (k.t) {
    case 's':
    case 's36':
    case 's36v4':
    case 'e':
      checkStr(k, x);
      return `"${x}"`;
    case 'u':
      if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < k.min || x > k.max)
        throw new Malformed(`${name} u`);
      return String(x);
    case 'b': {
      const b = asBytes(x, name);
      if (b.length === 0) {
        if (!k.empty) throw new Malformed(`${name} empty`);
        return '""';
      }
      checkBin(k, b);
      return `"${b64e(b)}"`;
    }
    default: {
      if (!Array.isArray(x) || x.length < k.min || x.length > k.max)
        throw new Malformed(`${name} count`);
      const elem = k.elem;
      const items = x.map((it: unknown) => {
        if (elem.t === 'b') {
          const b = asBytes(it, name);
          if (b.length === 0) throw new Malformed(`${name} empty item`);
          checkBin(elem, b);
          return b64e(b);
        }
        if (it === '') throw new Malformed(`${name} empty item`);
        checkStr(elem, it);
        return it;
      });
      if (k.t === 'a') {
        items.sort(cmp);
        for (let i = 1; i < items.length; i++) {
          if (items[i] === items[i - 1]) throw new Malformed(`${name} duplicate`);
        }
      }
      return `[${items.map((s) => `"${s}"`).join(',')}]`;
    }
  }
}

const bytesOf = (v: Values, n: string): Uint8Array => v[n] as Uint8Array;

// Cross-position rules that read only the message's own positions.
const CROSS: Record<string, (v: Values) => void> = {
  signed: (v) => {
    const want = utf8(`["${PREFIX}",1,"${v.type as string}",`);
    if (!equalBytes(bytesOf(v, 'msg').subarray(0, want.length), want)) {
      throw new Malformed('signed type is not msg[2]');
    }
    const dual = v.type === 'delegation' || v.type === 'succession';
    if (dual && bytesOf(v, 'sig_b').length === 0) throw new Malformed('missing second signature');
    if (!dual && bytesOf(v, 'sig_b').length !== 0)
      throw new Malformed('unexpected second signature');
  },
  'relay-recover': (v) => {
    const has = (n: string): boolean => bytesOf(v, n).length > 0;
    const rest = [
      'sig_candidate',
      'ek_binding',
      'ek_binding_sig',
      'recovery_bind_sig',
      'device_intent',
      'sig_new_device',
    ].some(has);
    const formR = [
      'intent',
      'sig_candidate',
      'ek_binding',
      'ek_binding_sig',
      'recovery_bind',
      'recovery_bind_sig',
      'device_intent',
      'sig_new_device',
    ].every(has);
    const formC = has('intent') && !has('recovery_bind') && !rest;
    const formB = !has('intent') && has('recovery_bind') && !rest;
    if (!formR && !formC && !formB) throw new Malformed('relay-recover form');
  },
  'device-set': (v) => {
    const active = v.active as string[];
    const pending = v.pending as string;
    if (pending !== '') {
      const prefix = pending.slice(0, pending.indexOf('.') + 1);
      if (active.some((d) => d.startsWith(prefix))) throw new Malformed('pending is in active');
    }
    // §2.5: IDs are pairwise distinct. Ascending records do not imply it
    // (id.dsk.dkx.5 < id.dsk.dkx.6), so compare the 36-character ids.
    const ids = active.map((d) => d.slice(0, 36)).sort(cmp);
    for (let i = 1; i < ids.length; i++)
      if (ids[i] === ids[i - 1]) throw new Malformed('duplicate device id');
    const recoveryKey = bytesOf(v, 'recovery_key');
    const replacementKey = bytesOf(v, 'replacement_key');
    const bound = recoveryKey.length > 0;
    const slot = bytesOf(v, 'replacement_bind_digest').length > 0;
    const hasKey = replacementKey.length > 0;
    if (bound !== bytesOf(v, 'recovery_bind_digest').length > 0)
      throw new Malformed('recovery key and digest');
    if (slot !== (v.replacement_nb_ms !== 0)) throw new Malformed('slot digest and nb');
    if (!slot && hasKey) throw new Malformed('slot key without digest');
    if (slot && !hasKey && !bound) throw new Malformed('pending unbind without a bound key');
    if (hasKey && equalBytes(replacementKey, recoveryKey))
      throw new Malformed('refresh to the bound key');
  },
  'recovery-bind': (v) => {
    const escrow = bytesOf(v, 'escrow_public_key');
    if (escrow.length > 0 && equalBytes(escrow, bytesOf(v, 'recovery_key'))) {
      throw new Malformed('escrow key equals the recovery key');
    }
  },
};

function layoutOf(tag: string): readonly (readonly [string, Kind])[] {
  if (!Object.hasOwn(LAYOUTS, tag)) throw new Malformed('unknown layout');
  return LAYOUTS[tag];
}

/** EN6: validate every position (the `dev` shape only) and write the canonical bytes. */
export function encode(tag: string, v: Values): Uint8Array {
  const fields = layoutOf(tag);
  let out = `["${PREFIX}",1,"${tag}"`;
  for (const [name, k] of fields) out += ',' + writeValue(k, v[name], name);
  out += ']';
  CROSS[tag]?.(v);
  if (out.length > capOf(tag)) throw new Malformed('length');
  return utf8(out);
}

async function readValue(k: Kind, x: unknown): Promise<Value> {
  switch (k.t) {
    case 's':
    case 's36':
    case 's36v4':
    case 'e':
      checkStr(k, x);
      if (k.t === 's' && k.chk === 'dev' && x !== '') await parseDev(x);
      return x;
    case 'u':
      if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < k.min || x > k.max)
        throw new Malformed('u');
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
      const out: (string | Uint8Array)[] = [];
      for (let i = 0; i < x.length; i++) {
        const item: unknown = x[i];
        if (typeof item !== 'string' || item === '') throw new Malformed('array item');
        if (k.t === 'a' && i > 0 && !((x[i - 1] as string) < item))
          throw new Malformed('not strictly ascending');
        out.push((await readValue(k.elem, item)) as string | Uint8Array);
      }
      return out;
    }
  }
}

const latin1 = new TextDecoder('latin1');

/** EN5: parse, validate every position, and require a byte-identical re-encode. */
export async function decode(tag: string, bytes: Uint8Array, limit?: number): Promise<Values> {
  const fields = layoutOf(tag);
  if (bytes.length > (limit ?? capOf(tag))) throw new Malformed('length');
  for (const c of bytes) if (!EN2.has(c)) throw new Malformed('EN2');
  let arr: unknown;
  try {
    arr = JSON.parse(latin1.decode(bytes));
  } catch {
    throw new Malformed('json');
  }
  if (!Array.isArray(arr) || arr.length !== 3 + fields.length) throw new Malformed('count');
  if (arr[0] !== PREFIX || arr[1] !== 1 || arr[2] !== tag)
    throw new Malformed('prefix, version or type');
  const v: Values = {};
  for (let i = 0; i < fields.length; i++)
    v[fields[i][0]] = await readValue(fields[i][1], arr[3 + i]);
  if (!equalBytes(encode(tag, v), bytes)) throw new Malformed('re-encode');
  return v;
}
