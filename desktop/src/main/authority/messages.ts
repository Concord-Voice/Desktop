// Typed views of the codec layouts the chain and device-ledger verifiers read
// (design of record §2.5, §2.6, §2.12). Field names are the layout position
// names, so a value decodes and re-encodes through the codec unchanged.

import { decode, encode, type Values } from './codec';
import { sha384, verifyP384 } from './primitives';

type Bytes = Uint8Array;

export interface Intent {
  realm_id: string;
  account_id: string;
  request_id: string;
  op: string;
  expires_at_ms: number;
  expected_seq: number;
  expected_recovery_gen: number;
  expected_head_digest: Bytes;
  predecessor_root_digest: Bytes;
  candidate_root: Bytes;
  ek_binding_digest: Bytes;
  legacy_ek_digest: Bytes;
  device_intent_digest: Bytes;
  recovery_bind_digest: Bytes;
}

export interface Sig {
  role: string;
  digest: Bytes;
}

export interface LegacyEkPop {
  realm_id: string;
  account_id: string;
  intent_digest: Bytes;
  legacy_ek_digest: Bytes;
}

export interface EkBinding {
  realm_id: string;
  account_id: string;
  root_digest: Bytes;
  ek_generation: number;
  ek_alg: string;
  ek_public_key: Bytes;
}

export interface CpAuthz {
  realm_id: string;
  account_id: string;
  request_id: string;
  intent_digest: Bytes;
  actor: string;
  asserted_at_ms: number;
  evidence_digest: Bytes;
}

export interface Result {
  realm_id: string;
  account_id: string;
  request_id: string;
  intent_digest: Bytes;
  cp_authz_digest: Bytes;
  op: string;
  seq: number;
  state: string;
  prior_state: string;
  suspended_by: string[];
  active_root: Bytes;
  root_revoked: number;
  ek_binding_digest: Bytes;
  pending_root: Bytes;
  pending_ek_binding_digest: Bytes;
  legacy_ek_digest: Bytes;
  legacy_pin_revoked: number;
  prev_entry_digest: Bytes;
  recovery_gen: number;
  activation_not_before_ms: number;
  assurance: string;
  issued_at_ms: number;
  delegation_gen: number;
  delegation_serial: number;
}

export interface Status {
  realm_id: string;
  account_id: string;
  seq: number;
  head_entry_digest: Bytes;
  state: string;
  prior_state: string;
  suspended_by: string[];
  active_root_digest: Bytes;
  root_revoked: number;
  ek_binding_digest: Bytes;
  pending_root_digest: Bytes;
  pending_ek_binding_digest: Bytes;
  legacy_ek_digest: Bytes;
  legacy_pin_revoked: number;
  activation_not_before_ms: number;
  held: number;
  as_of_ms: number;
  valid_until_ms: number;
  delegation_gen: number;
  delegation_serial: number;
}

export interface Delegation {
  realm_id: string;
  serial: number;
  min_valid_serial: number;
  product_root_gen: number;
  rsk_public_keys: Bytes[];
  cak_public_keys: Bytes[];
  operator_public_keys: Bytes[];
  authority_tls_keys: Bytes[];
  cp_tls_pins: Bytes[];
  not_before_ms: number;
  not_after_ms: number;
  scope: string[];
  accepted_versions: string[];
  tau_ms: number;
  delta_ms: number;
  g_ms: number;
  cutover_at_ms: number;
}

export interface Succession {
  realm_id: string;
  prev_root_gen: number;
  new_root_gen: number;
  new_primary_a: Bytes;
  new_primary_b: Bytes;
  new_recovery_a: Bytes;
  new_recovery_b: Bytes;
}

export interface Anchors {
  realm_id: string;
  primary_a: Bytes;
  primary_b: Bytes;
  recovery_a: Bytes;
  recovery_b: Bytes;
}

export interface Signed {
  type: string;
  msg: Bytes;
  sig_a: Bytes;
  sig_b: Bytes;
}

export interface TrustEnvelope {
  items: Bytes[];
}

export interface Bundle {
  intent: Bytes;
  sig_candidate: Bytes;
  sig_current_root: Bytes;
  sig_operator: Bytes;
  sig_recovery: Bytes;
  legacy_pop_sig: Bytes;
  legacy_spki: Bytes;
  ek_binding: Bytes;
  ek_binding_sig: Bytes;
  recovery_bind: Bytes;
  recovery_bind_sig: Bytes;
  cp_authz: Bytes;
  cp_authz_sig: Bytes;
  result: Bytes;
  result_sig: Bytes;
  held_status: Bytes;
}

export interface RecoveryBind {
  realm_id: string;
  account_id: string;
  request_id: string;
  kind: string;
  expires_at_ms: number;
  recovery_key: Bytes;
  target_digest: Bytes;
  chain_seq: number;
  chain_entry_digest: Bytes;
  binding_root_digest: Bytes;
  escrow_public_key: Bytes;
}

export interface RelayRecover {
  intent: Bytes;
  sig_candidate: Bytes;
  sig_recovery: Bytes;
  ek_binding: Bytes;
  ek_binding_sig: Bytes;
  recovery_bind: Bytes;
  recovery_bind_sig: Bytes;
  device_intent: Bytes;
  sig_new_device: Bytes;
}

/** The persisted `chain-head` (§2.12, D-269). Callers store and compare it only as bytes. */
export interface ChainHead {
  realm_id: string;
  account_id: string;
  head_result: Bytes;
  fix: Bytes;
  active_ek_spki: Bytes;
  active_ek_generation: number;
  pending_ek_spki: Bytes;
  pending_ek_generation: number;
  pending_recovery_key: Bytes;
  seq_index: string[];
  root_index: string[];
  ek_index: Bytes[];
  recover_index: string[];
}

export interface DeviceSet {
  realm_id: string;
  account_id: string;
  active: string[];
  pending: string;
  recovery_key: Bytes;
  recovery_bind_digest: Bytes;
  replacement_key: Bytes;
  replacement_bind_digest: Bytes;
  replacement_nb_ms: number;
}

export interface DeviceIntent {
  realm_id: string;
  account_id: string;
  request_id: string;
  op: string;
  salt: Bytes;
  expires_at_ms: number;
  expected_seq: number;
  expected_head_digest: Bytes;
  expected_dseq: number;
  expected_device_head: Bytes;
  actor_device_id: string;
  new_device_id: string;
  new_device_dsk: Bytes;
  new_device_dkx: Bytes;
  removed_device_ids: string[];
  recovery_bind_digest: Bytes;
  bind_wait: string;
}

export interface DeviceResult {
  realm_id: string;
  account_id: string;
  request_id: string;
  device_intent_digest: Bytes;
  cp_authz_digest: Bytes;
  op: string;
  dseq: number;
  prev_device_entry_digest: Bytes;
  chain_seq: number;
  chain_entry_digest: Bytes;
  device_set_digest: Bytes;
  issued_at_ms: number;
  delegation_gen: number;
  delegation_serial: number;
}

export interface DeviceStatus {
  realm_id: string;
  account_id: string;
  chain_seq: number;
  chain_head_digest: Bytes;
  dseq: number;
  device_head_digest: Bytes;
  device_set_digest: Bytes;
  as_of_ms: number;
  valid_until_ms: number;
  delegation_gen: number;
  delegation_serial: number;
}

export interface DeviceBundle {
  device_intent: Bytes;
  sig_root: Bytes;
  sig_actor: Bytes;
  sig_new_device: Bytes;
  recovery_bind: Bytes;
  sig_recovery: Bytes;
  sig_recovery_prior: Bytes;
  cp_authz: Bytes;
  cp_authz_sig: Bytes;
  device_result: Bytes;
  device_result_sig: Bytes;
}

export interface DeviceWrap {
  realm_id: string;
  account_id: string;
  recipient_device_id: string;
  device_entry_digest: Bytes;
  epk: Bytes;
  nonce: Bytes;
  ct: Bytes;
}

export interface DeviceSecrets {
  root_pkcs8: Bytes;
  ek_pkcs8: Bytes;
}

/** The `device-head` layout; chain_head_digest pairs it with its chain-head (D-269). */
export interface DeviceHeadWire {
  realm_id: string;
  account_id: string;
  self_device_id: string;
  last_device_result: Bytes;
  device_set: Bytes;
  chain_head_digest: Bytes;
  admitted_by: string[];
  secrets: string[];
}

interface Layouts {
  intent: Intent;
  sig: Sig;
  'legacy-ek-pop': LegacyEkPop;
  'ek-binding': EkBinding;
  'cp-authz': CpAuthz;
  result: Result;
  status: Status;
  delegation: Delegation;
  succession: Succession;
  anchors: Anchors;
  signed: Signed;
  trust: TrustEnvelope;
  bundle: Bundle;
  'recovery-bind': RecoveryBind;
  'relay-recover': RelayRecover;
  'chain-head': ChainHead;
  'device-set': DeviceSet;
  'device-intent': DeviceIntent;
  'device-result': DeviceResult;
  'device-status': DeviceStatus;
  'device-bundle': DeviceBundle;
  'device-wrap': DeviceWrap;
  'device-secrets': DeviceSecrets;
  'device-head': DeviceHeadWire;
}

/** EN5 decode as a typed view; null for any refusal (the caller's `malformed`). */
export async function decodeAs<K extends keyof Layouts>(
  tag: K,
  b: Uint8Array
): Promise<Layouts[K] | null> {
  try {
    return (await decode(tag, b)) as unknown as Layouts[K];
  } catch {
    return null;
  }
}

/** EN6 encode of a typed view; null when the value is not a valid message. */
export function encodeAs<K extends keyof Layouts>(tag: K, v: Layouts[K]): Uint8Array | null {
  try {
    return encode(tag, v as unknown as Values);
  } catch {
    return null;
  }
}

/**
 * The `sig` message a role signs (§2.5); null when role or digest is invalid.
 * No signature verifies over null, so an invalid input fails closed.
 */
export const sigMsg = (role: string, digest: Uint8Array): Uint8Array | null =>
  encodeAs('sig', { role, digest });

/** ECDSA P-384 over a rebuilt message; a null message (one that did not encode) never verifies. */
export const verifyOver = async (
  point: Uint8Array,
  msg: Uint8Array | null,
  sig: Uint8Array
): Promise<boolean> => msg !== null && verifyP384(point, msg, sig);

/** The digest of a key, or empty bytes for an absent one ("" on the wire). */
export const digestOrEmpty = async (b: Uint8Array): Promise<Uint8Array> =>
  b.length === 0 ? new Uint8Array(0) : sha384(b);
