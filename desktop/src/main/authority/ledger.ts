// The private device ledger (design of record §2.12; DR1–DR9, LD-32, D-240,
// D-257, D-272, C4-4). A port of Concord-Voice/Self-Hosted
// services/control-plane/internal/authoritycontract/ledger.go; its header
// states the invariant in full. In short, a ledger extends `from` only when:
//
//   - the chain bundles verify exactly as verifyChain verifies them, to a state
//     verdict that lets the chain persist (that verdict is returned);
//   - the device-status is RSK-signed, names that status's realm, account, seq,
//     head, as_of, valid_until and delegation (DR7), and is within τ of now
//     whatever the Use;
//   - the entries are contiguous in dseq and hash-linked from the persisted last
//     entry, and no entry's chain_seq is below the previous entry's (D-272);
//   - each published op whose intent #15 is set is followed by exactly one
//     attached entry naming its entry digest, whose device part is the one #15
//     commits to (D-240); every other entry is a private op naming the published
//     head current at its commit;
//   - each entry keeps §2.5's identity rules, V2-04's positions and R1's bounds,
//     every DR3 signature verifies under a key the WALK holds (never one the
//     entry names for itself), and applyDeviceOp admits it under a delegation
//     whose RSK signed it, giving exactly its device_set_digest;
//   - the entry-less changes are applied where the walk derives them (DR8's
//     clearPending, row 22's emptied slot, the slot's completion, and a raw
//     pending head's new-root activation);
//   - the device-status's dseq, head digest and set digest equal the walk's.
//
// Timing is held as hypotheses, never computed: own devices cannot see when the
// authority completes a slot or activates a head, so the walk forks at every
// event where either may have happened and keeps every history the chain's own
// verdicts leave open (DR9 (c), R3, A6, A11), at most MAX_LEDGER_HYPOTHESES.

import { cmp, equalBytes } from './bytes';
import { EPSILON_MS, INTENT_WINDOW_MS, CANCEL_SLACK_MS, addMs, sumBelow } from './constants';
import { slotsOf, STATE_REASONS, verifyChainSteps, type ChainStep, type EkSlots } from './chain';
import {
  activeIdx,
  applyDeviceOp,
  deviceSetDigest,
  emptyDeviceSet,
  normalizeDeviceSet,
  parseSet,
  type DeviceOpInput,
  type DevSet,
  type HeadInput,
  type Normalize,
} from './devicerules';
import {
  admittedRecord,
  deviceHeadBytes,
  headPub,
  secretsRecord,
  type ChainHead,
  type DeviceHead,
} from './heads';
import {
  decodeAs,
  digestOrEmpty,
  sigMsg,
  verifyOver,
  type CpAuthz,
  type Delegation,
  type DeviceBundle,
  type DeviceIntent,
  type DeviceResult,
  type DeviceSet,
  type DeviceStatus,
  type RecoveryBind,
  type Status,
} from './messages';
import { actorOpName, attachedOp, deviceIntentForOp, recoveryBindForKind } from './patterns';
import { isUUIDv4, sha384, type DevRecord } from './primitives';
import { activate, pubOfResult, type Pub } from './pub';
import type { Reason } from './reason';
import { effectiveOf, effectivePending, fixAllows, fixNames, fixStatus } from './replay';
import type { AccountMemory, Use } from './status';
import type { HighWater, Trust } from './trust';
import { checkT7, checkT8, rskRule, rskVerifies } from './trustcheck';

const NONE = new Uint8Array(0);

/**
 * The live hypotheses one call may hold. A ledger the authority writes never
 * holds more than 4 after deduplication; one past this bound is refused
 * (device_rule) rather than trimmed, since dropping a live hypothesis could
 * refuse an honest ledger silently.
 */
export const MAX_LEDGER_HYPOTHESES = 8;

// ── One entry: EN5 and the rules that read no hypothesis ─────────────────────

interface ParsedDevice {
  raw: DeviceBundle;
  di: DeviceIntent | null; // null on the sheet form of cancel_recovery_bind
  dr: DeviceResult;
  entry: Uint8Array; // SHA-384 of the device-result: the device entry digest
  authz: CpAuthz | null;
  authzDigest: Uint8Array;
  bind: RecoveryBind | null;
  bindDigest: Uint8Array;
  d: Uint8Array; // the digest the entry's signatures cover: D, or H(B) on the sheet form
}

/** EN5 over every part of one entry; null is malformed. */
async function parseDevice(b: Uint8Array): Promise<ParsedDevice | null> {
  const raw = await decodeAs('device-bundle', b);
  const dr = raw && (await decodeAs('device-result', raw.device_result));
  if (!raw || !dr) return null;
  const nested = async <T>(bytes: Uint8Array, f: (x: Uint8Array) => Promise<T | null>) =>
    bytes.length > 0 ? f(bytes) : undefined;
  const di = await nested(raw.device_intent, (x) => decodeAs('device-intent', x));
  const authz = await nested(raw.cp_authz, (x) => decodeAs('cp-authz', x));
  const bind = await nested(raw.recovery_bind, (x) => decodeAs('recovery-bind', x));
  if (di === null || authz === null || bind === null) return null;
  const bindDigest = bind ? await sha384(raw.recovery_bind) : NONE;
  return {
    raw,
    di: di ?? null,
    dr,
    entry: await sha384(raw.device_result),
    authz: authz ?? null,
    authzDigest: authz ? await sha384(raw.cp_authz) : NONE,
    bind: bind ?? null,
    bindDigest,
    d: di ? await sha384(raw.device_intent) : bindDigest,
  };
}

async function parseDevices(bundles: Uint8Array[]): Promise<ParsedDevice[] | null> {
  const out: ParsedDevice[] = [];
  for (const b of bundles) {
    const p = await parseDevice(b);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** device-result #5's request: its device-intent's, or B's on the sheet form. */
const requestId = (p: ParsedDevice): string => p.di?.request_id ?? p.bind?.request_id ?? '';
/** The entry's expiry: device-intent #8, or B #7 on the sheet form. */
const expires = (p: ParsedDevice): number => p.di?.expires_at_ms ?? p.bind?.expires_at_ms ?? 0;

/** The root form of cancel_recovery_bind: B's expiry is device-intent #8 (E3-10, V3-06). */
const rootCancelExpiryIsIntents = (p: ParsedDevice): boolean =>
  p.di === null ||
  p.bind === null ||
  p.di.op !== 'cancel_recovery_bind' ||
  p.bind.expires_at_ms === p.di.expires_at_ms;

function sameAccount(p: ParsedDevice, realm: string, account: string): boolean {
  const parts = [p.dr, p.di, p.authz, p.bind].filter((x) => x !== null);
  return parts.every((x) => x.realm_id === realm && x.account_id === account);
}

/** §2.5's attached identity: the published intent's request, op and expected head; the result's op, issued_at and delegation. */
function attachedTo(p: ParsedDevice, s: ChainStep): boolean {
  const { intent: inp } = s.pb;
  const { res } = s;
  return (
    p.di !== null &&
    p.di.request_id === inp.request_id &&
    p.di.op === inp.op &&
    p.di.expected_seq === inp.expected_seq &&
    equalBytes(p.di.expected_head_digest, inp.expected_head_digest) &&
    p.dr.op === res.op &&
    p.dr.issued_at_ms === res.issued_at_ms &&
    p.dr.delegation_gen === res.delegation_gen &&
    p.dr.delegation_serial === res.delegation_serial
  );
}

/** device-result #7: a cp-authz rides only on a private op, is digested there and names the entry's request. */
function authzConsistent(p: ParsedDevice): boolean {
  if ((p.authz !== null) !== p.dr.cp_authz_digest.length > 0) return false;
  if (!p.authz) return true;
  return (
    !attachedOp(p.dr.op) &&
    equalBytes(p.dr.cp_authz_digest, p.authzDigest) &&
    p.authz.request_id === p.dr.request_id
  );
}

/** §2.5's identity rules for one entry (device_rule). */
function consistent(p: ParsedDevice, step: ChainStep | null): boolean {
  const { dr, di, bind } = p;
  if (!di && (dr.op !== 'cancel_recovery_bind' || !bind)) return false; // only the sheet form lacks a device-intent
  if (
    !equalBytes(dr.device_intent_digest, p.d) ||
    dr.request_id !== requestId(p) ||
    (bind !== null && bind.request_id !== dr.request_id) ||
    !rootCancelExpiryIsIntents(p)
  )
    return false;
  if (di && (di.op !== dr.op || (step === null && di.expected_seq !== dr.chain_seq))) return false;
  return authzConsistent(p) && (step === null || attachedTo(p, step));
}

/** V2-04 on own devices: a B on exactly the ops that carry one, and the device-intent positions its op uses. */
function forOp(p: ParsedDevice, step: ChainStep | null): boolean {
  const usesBind = p.dr.op === 'bind_recovery' || p.dr.op === 'cancel_recovery_bind';
  if (usesBind !== (p.bind !== null)) return false;
  if (
    p.bind &&
    (recoveryBindForKind(p.bind) !== '' ||
      (p.di !== null && !equalBytes(p.di.recovery_bind_digest, p.bindDigest)))
  )
    return false;
  return !p.di || deviceIntentForOp(p.di, step?.pb.intent.candidate_root ?? NONE) === '';
}

/**
 * device-result #14: a private entry keeps R1's bounds against its cp-authz,
 * and a cancel_recovery_bind the cancel bounds under d's grace.
 */
function issuedBounds(p: ParsedDevice, d: Delegation): Reason {
  if (!p.authz || attachedOp(p.dr.op)) return 'ok';
  const a = p.authz.asserted_at_ms;
  const issued = p.dr.issued_at_ms;
  const exp = expires(p);
  if (issued + EPSILON_MS < a) return 'issued_bounds';
  if (p.dr.op === 'cancel_recovery_bind') {
    const hi = addMs(a, d.g_ms, CANCEL_SLACK_MS);
    return hi === null || issued >= hi || exp <= a ? 'issued_bounds' : 'ok';
  }
  const hi = addMs(a, INTENT_WINDOW_MS) ?? Number.MAX_SAFE_INTEGER;
  return issued >= Math.min(exp, hi) ? 'issued_bounds' : 'ok';
}

/** claims: p is step s's attached entry (DR7, D-240). */
const claims = (p: ParsedDevice, s: ChainStep): boolean =>
  attachedOp(p.dr.op) &&
  p.dr.chain_seq === s.res.seq &&
  equalBytes(p.dr.chain_entry_digest, s.pb.entry) &&
  equalBytes(p.dr.device_intent_digest, s.pb.intent.device_intent_digest);

/** DR7's device-status checks against the verified status. */
async function verifyDeviceStatus(
  t: Trust,
  b: Uint8Array,
  st: Status
): Promise<[DeviceStatus | null, Reason]> {
  const sg = await decodeAs('signed', b);
  const ds = sg?.type === 'device-status' ? await decodeAs('device-status', sg.msg) : null;
  if (!sg || !ds) return [null, 'malformed'];
  let signed = false;
  for (const d of t.delegations(ds.delegation_gen, ds.delegation_serial))
    signed ||= await rskVerifies(d, sg.msg, sg.sig_a);
  if (!signed) return [ds, 'bad_signature'];
  if (ds.realm_id !== st.realm_id || ds.account_id !== st.account_id) return [ds, 'realm_mismatch'];
  if (ds.chain_seq < st.seq || ds.as_of_ms < st.as_of_ms) return [ds, 'device_status_stale'];
  const same =
    ds.chain_seq === st.seq &&
    equalBytes(ds.chain_head_digest, st.head_entry_digest) &&
    ds.as_of_ms === st.as_of_ms &&
    ds.valid_until_ms === st.valid_until_ms &&
    ds.delegation_gen === st.delegation_gen &&
    ds.delegation_serial === st.delegation_serial;
  return [ds, same ? 'ok' : 'device_status_mismatch'];
}

// ── One hypothesis ───────────────────────────────────────────────────────────

/** A pending head whose derived activation installs a new root: P(x) or Pr(x). */
const installsRoot = (p: Pub): boolean => p.state === 'pending' && p.pendRoot.length > 0;

/**
 * What the persisted heads prove about the slot the persisted set holds
 * pending, through the from head's retained fix (R4): pending at every event
 * at or before `after` (RT6-9), or, when the fix shows a new-root activation
 * this set stops before, never completed before that activation (C4-4).
 */
export interface SlotFloor {
  digest: Uint8Array; // the slot's replacement_bind_digest; empty when nothing is proven
  after: number;
  never: boolean;
}

const NO_FLOOR: SlotFloor = Object.freeze({ digest: NONE, after: 0, never: false });

function slotFloorOf(set: DeviceSet, raw: Pub, fix: Status | null, taken: boolean): SlotFloor {
  if (set.replacement_bind_digest.length === 0 || !fixNames(fix, raw)) return NO_FLOOR;
  return {
    digest: set.replacement_bind_digest,
    after: fix.as_of_ms,
    never: installsRoot(raw) && !taken && !effectivePending(raw, fix),
  };
}

/**
 * RT6-9 and C4-4: the slot named digest is held pending for an event at x when
 * the fix showed it pending at or after x, or it never completes before the
 * activation that came first. Exported for its boundary test.
 */
export const floorHolds = (f: SlotFloor, digest: Uint8Array, x: number): boolean =>
  equalBytes(f.digest, digest) && (f.never || x <= f.after);

/** The chain one call reads, shared by every hypothesis. */
interface Shared {
  t: Trust;
  hw: HighWater;
  from: ChainHead;
  fromPub: Pub;
  base: number; // the from head's seq
  fix: Status | null; // R4: the from head's retained status
  steps: ChainStep[];
  final: Pub; // the effective head the verified status shows
  asOf: number;
  self: string;
}

/** One hypothesis: the set, its position in the ledger, and the activation it has taken. */
interface Walk {
  set: Uint8Array;
  dseq: number;
  last: Uint8Array; // the last device entry digest
  lastDR: Uint8Array; // the last device-result's bytes
  floor: number; // DR7's ordering floor: the last entry's chain_seq (D-272)
  actDone: number; // the seq whose derived activation this hypothesis has taken
  slotFloor: SlotFloor;
  admitted: Map<string, string>;
  secrets: string[];
  superseded: boolean; // an entry under a superseded delegation (T7)
}

const clone = (w: Walk): Walk => ({
  ...w,
  admitted: new Map(w.admitted),
  secrets: [...w.secrets],
});

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
}

/** An equal hypothesis: the set and the activation taken, and with full the records a live one persists. */
function same(a: Walk, b: Walk, full: boolean): boolean {
  if (a.actDone !== b.actDone || !equalBytes(a.set, b.set)) return false;
  return (
    !full ||
    (sameMap(a.admitted, b.admitted) &&
      a.secrets.length === b.secrets.length &&
      a.secrets.every((s, i) => s === b.secrets[i]))
  );
}

function dedupe(ws: Walk[], full: boolean): Walk[] {
  const out: Walk[] = [];
  for (const w of ws) if (!out.some((o) => same(o, w, full))) out.push(w);
  return out;
}

const normalize = async (set: Uint8Array, f: Normalize): Promise<Uint8Array> =>
  (await normalizeDeviceSet(set, f)) ?? NONE;

/** The verified published head at chain seq k and its EK slots; null outside the chain. */
async function headAt(c: Shared, k: number): Promise<[Pub, EkSlots] | null> {
  if (k === c.base) return [c.fromPub, slotsOf(c.from)];
  if (k < c.base || k - c.base > c.steps.length) return null;
  const s = c.steps[k - c.base - 1];
  return [await pubOfResult(s.res, s.pb.resBytes, s.ek.activeGen, s.ek.pendingGen), s.ek];
}

/** What the chain fixed about the head at seq k: the next result's matched hypothesis (R3) or the status (R5). */
function verdict(c: Shared, k: number): [boolean, number] {
  const i = k - c.base;
  if (i < c.steps.length) return [c.steps[i].act, c.steps[i].res.issued_at_ms];
  return [c.final.state !== 'pending', c.asOf];
}

/** Whether an event at x may read the raw pending head at seq k as activated (act) or pending. */
function mayRead(c: Shared, raw: Pub, k: number, x: number, act: boolean): boolean {
  if (act && x < raw.anb) return false;
  if (k === c.base && !fixAllows(c.fix, raw, x, act)) return false;
  const [vAct, at] = verdict(c, k);
  if (!vAct) return !act;
  return act || x < at;
}

/** false takes no activation at x, true takes it now; none when w took it at an instant x may not read. */
function activationChoices(c: Shared, w: Walk, raw: Pub, k: number, x: number): boolean[] {
  if (raw.state !== 'pending') return [false];
  if (w.actDone === k) return mayRead(c, raw, k, x, true) ? [false] : [];
  return [false, true].filter((act) => mayRead(c, raw, k, x, act));
}

/** A pending slot is pending, or completed, at any x at or after replacement_nb_ms (DR9 (c), G-41). */
async function completionChoices(w: Walk, x: number): Promise<boolean[]> {
  const s = await decodeAs('device-set', w.set);
  if (
    !s ||
    s.replacement_bind_digest.length === 0 ||
    x < s.replacement_nb_ms ||
    floorHolds(w.slotFloor, s.replacement_bind_digest, x)
  )
    return [false];
  return [false, true];
}

/** One hypothesis at an event: act reports the activation taken there, pre the set just before it. */
interface Branch {
  w: Walk;
  pre: Uint8Array;
  act: boolean;
}

/** The completion, then the activation: complete with a new-root activation is completion first (C4-4, LD-52). */
async function take(
  w: Walk,
  raw: Pub,
  k: number,
  complete: boolean,
  act: boolean
): Promise<Branch> {
  const c = clone(w);
  if (complete) c.set = await normalize(c.set, { completeSlot: true });
  const b: Branch = { w: c, pre: c.set, act };
  if (act) {
    c.actDone = k;
    if (installsRoot(raw))
      c.set = await normalize(c.set, { activate: true, burnRecovery: raw.op === 'recover' });
  }
  return b;
}

async function branches(c: Shared, w: Walk, raw: Pub, k: number, x: number): Promise<Branch[]> {
  const acts = activationChoices(c, w, raw, k, x);
  const out: Branch[] = [];
  for (const complete of await completionChoices(w, x))
    for (const act of acts) out.push(await take(w, raw, k, complete, act));
  return out;
}

async function forkAll(c: Shared, ws: Walk[], raw: Pub, k: number, x: number): Promise<Walk[]> {
  const out: Walk[] = [];
  for (const w of ws) for (const b of await branches(c, w, raw, k, x)) out.push(b.w);
  return out;
}

// ── One entry under one hypothesis ───────────────────────────────────────────

/** The published head an entry acted on and the EK active after it. */
async function actedOn(
  c: Shared,
  w: Walk,
  p: ParsedDevice,
  step: ChainStep | null
): Promise<[Pub, Uint8Array] | null> {
  if (step) return [step.from, step.ek.active];
  const at = await headAt(c, p.dr.chain_seq);
  if (!at) return null;
  const [raw, ch] = at;
  const taken = raw.state === 'pending' && w.actDone === p.dr.chain_seq;
  const eff = taken ? activate(raw) : raw;
  return equalBytes(p.dr.chain_entry_digest, eff.entry)
    ? [eff, taken ? ch.pending : ch.active]
    : null;
}

const headInputOf = async (p: Pub): Promise<HeadInput> => ({
  state: p.state,
  seq: p.seq,
  entryDigest: p.entry,
  rootDigest: await digestOrEmpty(p.root),
  forceUnverified: false,
});

/** device-intent #14–#16; DR1 checks that #14 is DeviceID(#15). */
const newDeviceOf = (di: DeviceIntent): DevRecord | null =>
  di.new_device_id === ''
    ? null
    : { id: di.new_device_id, dsk: di.new_device_dsk, dkx: di.new_device_dkx, matureAtMs: 0 };

/** DR5/DR6's P or D outcome of a proposing result. */
function outcomeOf(state: string): string {
  if (state === 'pending') return 'P';
  return state === 'disputed' ? 'D' : '';
}

/** applyDeviceOp's input from the entry (D-270); a recover's B rides in its published bundle. */
async function input(p: ParsedDevice, eff: Pub, step: ChainStep | null): Promise<DeviceOpInput> {
  const isRecover = step !== null && p.dr.op === 'recover';
  return {
    op: p.dr.op,
    actor: p.di?.actor_device_id ?? '',
    new: p.di ? newDeviceOf(p.di) : null,
    removed: p.di?.removed_device_ids ?? [],
    bind: isRecover ? step.pb.raw.recovery_bind : p.raw.recovery_bind,
    bindWait: p.di?.bind_wait ?? '',
    priorSig: p.raw.sig_recovery_prior.length > 0,
    rootForm: p.dr.op === 'cancel_recovery_bind' && p.di !== null,
    head: await headInputOf(eff),
    outcome: step ? outcomeOf(step.res.state) : '',
    proposingAnbMs: step ? step.res.activation_not_before_ms : 0,
  };
}

/** One DR3 signature: sig over sigMsg(role, digest) under key. */
interface DevSig {
  sig: Uint8Array;
  key: Uint8Array;
  digest: Uint8Array;
  role: string;
}

/** A missing signature, or a key the walk does not hold, is device_rule; a failing one is bad_signature. */
async function checkSig(q: DevSig): Promise<Reason> {
  if (q.sig.length === 0 || q.key.length === 0) return 'device_rule';
  return (await verifyOver(q.key, sigMsg(q.role, q.digest), q.sig)) ? 'ok' : 'bad_signature';
}

/**
 * DR3's signatures. Every key comes from the walk: the actor's dsk from the set
 * before the entry, the root of the effective head, the bound recovery key;
 * only sig_new_device and a bind's sig_recovery verify under the key the entry
 * introduces, which is what they prove.
 */
function devSigs(p: ParsedDevice, eff: Pub, inp: DeviceOpInput, s: DevSet): DevSig[] {
  const { d: D, bindDigest: HB, raw: b } = p;
  const qs: DevSig[] = [];
  if (inp.actor !== '') {
    const i = activeIdx(s, inp.actor);
    const key = i >= 0 ? s.act[i].dsk : NONE;
    qs.push({ sig: b.sig_actor, key, digest: D, role: 'actor-device' });
  }
  if (inp.new) qs.push({ sig: b.sig_new_device, key: inp.new.dsk, digest: D, role: 'new-device' });
  const root = (digest: Uint8Array): DevSig => ({
    sig: b.sig_root,
    key: eff.root,
    digest,
    role: 'current-root',
  });
  const recovery = (sig: Uint8Array, key: Uint8Array): DevSig => ({
    sig,
    key,
    digest: HB,
    role: 'recovery-key',
  });
  switch (p.dr.op) {
    case 'add_device':
      qs.push(root(D));
      break;
    case 'bind_recovery':
      qs.push(root(HB));
      if (p.bind?.kind !== 'unbind')
        qs.push(recovery(b.sig_recovery, p.bind?.recovery_key ?? NONE));
      if (inp.priorSig) qs.push(recovery(b.sig_recovery_prior, s.v.recovery_key));
      break;
    case 'cancel_recovery_bind':
      qs.push(inp.rootForm ? root(HB) : recovery(b.sig_recovery, s.v.recovery_key));
      break;
  }
  return qs;
}

/** DR3: the private signatures, then a private op's cp-authz over D under a CAK T8 admits. */
async function checkSigs(
  c: Shared,
  w: Walk,
  p: ParsedDevice,
  eff: Pub,
  inp: DeviceOpInput
): Promise<Reason> {
  const s = await parseSet(w.set);
  if (!s) return 'device_rule';
  for (const q of devSigs(p, eff, inp, s)) {
    const r = await checkSig(q);
    if (r !== 'ok') return r;
  }
  if (attachedOp(p.dr.op)) return 'ok';
  if (!p.authz || !equalBytes(p.authz.intent_digest, p.d)) return 'device_rule';
  const { delegation_gen: gen, delegation_serial: serial } = p.dr;
  return checkT8(c.t, p.raw.cp_authz, p.raw.cp_authz_sig, gen, serial, p.authz.asserted_at_ms);
}

async function selfActive(set: Uint8Array, self: string): Promise<boolean> {
  const s = await parseSet(set);
  return s !== null && activeIdx(s, self) >= 0;
}

/**
 * Self's secrets entries (device-secrets check 3): an add_device admitting
 * self, with the effective root and EK it was admitted under, or a rotate_root
 * or rotate_ek after which self is active, with the result's root (rotate_root)
 * and the EK the result made active.
 */
async function recordSecrets(
  c: Shared,
  w: Walk,
  p: ParsedDevice,
  eff: Pub,
  ek: Uint8Array,
  step: ChainStep | null
): Promise<void> {
  if (c.self === '') return;
  const op = p.dr.op;
  let root: Uint8Array;
  if (op === 'add_device' && p.di?.new_device_id === c.self) root = eff.root;
  else if (
    step &&
    (op === 'rotate_root' || op === 'rotate_ek') &&
    (await selfActive(w.set, c.self))
  )
    root = op === 'rotate_root' ? step.res.active_root : NONE;
  else return;
  w.secrets.push(secretsRecord(p.entry, op, root, ek));
}

/** The entry under delegation d, on w in place: R1's bounds, the head it acted on, DR3, the shared rules and the set digest. */
async function apply(
  c: Shared,
  w: Walk,
  p: ParsedDevice,
  step: ChainStep | null,
  d: Delegation
): Promise<Reason> {
  const ib = issuedBounds(p, d);
  if (ib !== 'ok') return ib;
  const acted = await actedOn(c, w, p, step);
  if (!acted) return 'device_fork';
  const [eff, ek] = acted;
  const inp = await input(p, eff, step);
  const sr = await checkSigs(c, w, p, eff, inp);
  if (sr !== 'ok') return sr;
  const [set, ref] = await applyDeviceOp(w.set, inp, p.dr.issued_at_ms, d.delta_ms);
  if (!set || ref !== '') return 'device_rule';
  const dig = await deviceSetDigest(set);
  if (!dig || !equalBytes(dig, p.dr.device_set_digest)) return 'device_rule';
  Object.assign(w, {
    set,
    dseq: p.dr.dseq,
    last: p.entry,
    lastDR: p.raw.device_result,
    floor: p.dr.chain_seq,
  });
  if (inp.new) w.admitted.set(inp.new.id, inp.actor);
  await recordSecrets(c, w, p, eff, ek, step);
  return 'ok';
}

/** The entry on a copy of w under the first delegation it applies under; else the first one's Reason. */
async function applyUnder(
  c: Shared,
  w: Walk,
  p: ParsedDevice,
  step: ChainStep | null,
  dels: Delegation[]
): Promise<Walk | Reason> {
  let first: Reason | null = null;
  for (const d of dels) {
    const x = clone(w);
    const r = await apply(c, x, p, step, d);
    if (r === 'ok') return x;
    first ??= r;
  }
  return first ?? 'delegation_unknown';
}

/** p on a refuted hypothesis as applyDeviceOp admits it (A11): no signature, no recorded digest. */
async function skim(
  c: Shared,
  w: Walk,
  p: ParsedDevice,
  step: ChainStep | null,
  d: Delegation
): Promise<void> {
  const acted = await actedOn(c, w, p, step);
  if (!acted) return;
  const [set] = await applyDeviceOp(
    w.set,
    await input(p, acted[0], step),
    p.dr.issued_at_ms,
    d.delta_ms
  );
  if (set) w.set = set;
}

/** The entry's place in the ledger and its own consistency (realm, dseq, link, D-272, §2.5, V2-04, DoR:413). */
function preEntry(c: Shared, w: Walk, p: ParsedDevice, step: ChainStep | null): Reason {
  const dr = p.dr;
  if (!sameAccount(p, c.from.realm_id, c.from.account_id)) return 'realm_mismatch';
  if (dr.dseq !== w.dseq + 1) return 'device_gap';
  if (!equalBytes(dr.prev_device_entry_digest, w.last)) return 'device_fork';
  if (dr.chain_seq < w.floor) return 'device_rule'; // DR7: never below an earlier entry's chain_seq
  if (!consistent(p, step) || !forOp(p, step)) return 'device_rule';
  // An op with an actor device names the private head it was built on, so an
  // owner-signed device-intent cannot be replayed at a later position.
  const di = p.di;
  if (
    di &&
    actorOpName(di.op) &&
    (di.expected_dseq !== w.dseq || !equalBytes(di.expected_device_head, w.last))
  )
    return 'device_rule';
  return 'ok';
}

const CLEAR_PENDING: Readonly<Normalize> = Object.freeze({ clearPending: true });

/** The entry-less change after a published result, by §2.9 row: DR8's clearPending and row 22's emptied slot. */
export const AFTER_EVENT: Readonly<Record<number, Readonly<Normalize>>> = Object.freeze({
  13: CLEAR_PENDING,
  14: CLEAR_PENDING,
  16: CLEAR_PENDING,
  17: CLEAR_PENDING,
  21: CLEAR_PENDING,
  22: Object.freeze({ clearPending: true, emptySlot: true }),
});

async function afterEvent(w: Walk, s: ChainStep): Promise<void> {
  const f = AFTER_EVENT[s.row];
  if (f) w.set = await normalize(w.set, f);
}

/** The Reason no hypothesis admits an entry under: the one they share, else device_rule (DR9 (c)). Exported for its test. */
export const sharedReason = (why: Reason[]): Reason =>
  why.every((r) => r === why[0]) ? why[0] : 'device_rule';

// ── The ledger: every hypothesis of one call ─────────────────────────────────

/** One hypothesis at the status's as_of: the set the device-status must show and the set it persists. */
interface Outcome {
  w: Walk;
  persisted: Uint8Array;
  shown: Uint8Array;
}

class Ledger {
  live: Walk[];
  refuted: Walk[] = [];

  constructor(
    private readonly c: Shared,
    w: Walk
  ) {
    this.live = [w];
  }

  /** Installs the next hypotheses; too many live is device_rule, none hypothesis_conflict. */
  keep(live: Walk[], refuted: Walk[]): Reason {
    this.live = dedupe(live, true);
    this.refuted = dedupe(refuted, false).slice(0, MAX_LEDGER_HYPOTHESES);
    if (this.live.length === 0) return 'hypothesis_conflict';
    return this.live.length > MAX_LEDGER_HYPOTHESES ? 'device_rule' : 'ok';
  }

  async settle(raw: Pub, k: number, x: number): Promise<Reason> {
    return this.keep(
      await forkAll(this.c, this.live, raw, k, x),
      await forkAll(this.c, this.refuted, raw, k, x)
    );
  }

  /** DR7's merge: before step k → k+1, every private entry at chain_seq ≤ k, in dseq order. */
  async run(entries: ParsedDevice[]): Promise<Reason> {
    const { base, steps } = this.c;
    let i = 0;
    for (let k = base; ; k++) {
      for (
        ;
        i < entries.length && !attachedOp(entries[i].dr.op) && entries[i].dr.chain_seq <= k;
        i++
      ) {
        const r = await this.entry(entries[i], null);
        if (r !== 'ok') return r;
      }
      if (k === base + steps.length) break;
      const r = await this.step(entries, i, steps[k - base]);
      if (typeof r === 'string') return r;
      i = r;
    }
    // An attached entry no published op claims, or a private entry ahead of the chain.
    return i === entries.length ? 'ok' : 'device_rule';
  }

  /** One published result: fork at its issued_at, its attached entry, then its entry-less change. */
  async step(entries: ParsedDevice[], i: number, s: ChainStep): Promise<number | Reason> {
    const k = s.res.seq - 1;
    const at = await headAt(this.c, k);
    if (!at) return 'malformed'; // the head s was verified against: unreachable, still refused
    const r = await this.settle(at[0], k, s.res.issued_at_ms);
    if (r !== 'ok') return r;
    let next = i;
    if (s.pb.intent.device_intent_digest.length > 0) {
      if (next >= entries.length || !claims(entries[next], s)) return 'device_gap';
      const er = await this.entry(entries[next], s);
      if (er !== 'ok') return er;
      next++;
    }
    for (const w of [...this.live, ...this.refuted]) await afterEvent(w, s);
    return next;
  }

  /** The hypotheses an entry is judged under, as copies: a private entry forks them at its issued_at. */
  async forks(ws: Walk[], p: ParsedDevice, step: ChainStep | null): Promise<Walk[]> {
    if (!step && ws.length > 0) {
      const at = await headAt(this.c, p.dr.chain_seq);
      if (at) return forkAll(this.c, ws, at[0], p.dr.chain_seq, p.dr.issued_at_ms);
    }
    return ws.map(clone);
  }

  /** preEntry and T7, then the retained delegations at the entry's (gen, serial) whose RSK signed it. */
  async admitEntry(
    p: ParsedDevice,
    step: ChainStep | null
  ): Promise<[Delegation[], boolean, Reason]> {
    const { c } = this;
    const pr = preEntry(c, this.live[0], p, step);
    if (pr !== 'ok') return [[], false, pr];
    const { dr } = p;
    const sig = p.raw.device_result_sig;
    const [sup, r] = await checkT7(c.t, c.hw, dr, p.raw.device_result, sig);
    if (r !== 'ok') return [[], false, r];
    const dels: Delegation[] = [];
    for (const d of c.t.delegations(dr.delegation_gen, dr.delegation_serial)) {
      const rr = await rskRule(d, p.raw.device_result, sig, dr.issued_at_ms, dr.op);
      if (rr === 'ok') dels.push(d);
    }
    // unreachable after checkT7, which found a delegation whose rskRule is ok
    return dels.length > 0 ? [dels, sup, 'ok'] : [[], false, 'delegation_unknown'];
  }

  /** One entry: the live hypotheses that admit it go on; those it refused join the refuted ones. */
  async entry(p: ParsedDevice, step: ChainStep | null): Promise<Reason> {
    const [dels, sup, r] = await this.admitEntry(p, step);
    if (r !== 'ok') return r;
    const cand = dedupe(await this.forks(this.live, p, step), true);
    if (cand.length === 0) return 'hypothesis_conflict';
    const live: Walk[] = [];
    const refusedWs: Walk[] = [];
    const why: Reason[] = [];
    for (const w of cand) {
      const x = await applyUnder(this.c, w, p, step, dels);
      if (typeof x === 'string') {
        refusedWs.push(w);
        why.push(x);
      } else {
        x.superseded ||= sup;
        live.push(x);
      }
    }
    if (live.length === 0) return sharedReason(why);
    refusedWs.push(...(await this.forks(this.refuted, p, step)));
    for (const w of refusedWs) await skim(this.c, w, p, step, dels[0]);
    return this.keep(live, refusedWs);
  }

  /** Every hypothesis forked at as_of on the last head, whose activation the status fixes (R5). */
  async outcomes(ws: Walk[], raw: Pub, end: number, asOf: number): Promise<Outcome[]> {
    const out: Outcome[] = [];
    for (const w of ws)
      for (const b of await branches(this.c, w, raw, end, asOf))
        out.push({ w: b.w, persisted: b.act ? b.pre : b.w.set, shown: b.w.set });
    return out;
  }

  /** DR7's last clause: the device-status names the last entry and shows a live hypothesis's set. */
  async resolve(
    ds: DeviceStatus,
    raw: Pub,
    end: number,
    asOf: number
  ): Promise<Outcome[] | Reason> {
    const w = this.live[0];
    if (ds.dseq > w.dseq) return 'device_behind';
    if (ds.dseq < w.dseq || !equalBytes(ds.device_head_digest, w.last)) return 'device_fork';
    const live = await this.outcomes(this.live, raw, end, asOf);
    if (live.length === 0) return 'hypothesis_conflict'; // the status's verdict contradicts the retained fix
    const shows = async (o: Outcome): Promise<boolean> => {
      const dig = await deviceSetDigest(o.shown);
      return dig !== null && equalBytes(dig, ds.device_set_digest);
    };
    const hits: Outcome[] = [];
    for (const o of live) if (await shows(o)) hits.push(o);
    if (hits.length > 0) return hits;
    for (const o of await this.outcomes(this.refuted, raw, end, asOf))
      if (await shows(o)) return 'device_rule';
    return 'device_status_mismatch';
  }
}

// ── Persisting ───────────────────────────────────────────────────────────────

/** The admitted_by records of the devices in the persisted set's active and pending. */
async function admittedRecords(w: Walk): Promise<string[]> {
  const s = await parseSet(w.set);
  if (!s) return [];
  const live = new Set([...s.act.map((e) => e.id), ...(s.pend ? [s.pend.id] : [])]);
  return [...w.admitted]
    .filter(([id]) => live.has(id))
    .map(([id, by]) => admittedRecord(id, by))
    .sort(cmp);
}

async function deviceHeadOf(w: Walk, from: DeviceHead, head: ChainHead): Promise<DeviceHead> {
  return {
    realm_id: from.realm_id,
    account_id: from.account_id,
    self_device_id: from.self_device_id,
    last_device_result: w.lastDR,
    device_set: w.dseq > 0 ? w.set : NONE, // device_set is "" until the first entry
    admitted_by: await admittedRecords(w),
    secrets: w.secrets,
    chain: head,
  };
}

/** The device-head every shown outcome persists; two that differ fail closed. */
async function persistOne(
  hits: Outcome[],
  from: DeviceHead,
  head: ChainHead
): Promise<[DeviceHead, Uint8Array] | Reason> {
  let out: DeviceHead | null = null;
  let first: Uint8Array | null = null;
  for (const o of hits) {
    const dh = await deviceHeadOf({ ...o.w, set: o.persisted }, from, head);
    const bytes = await deviceHeadBytes(dh);
    if (!bytes) return 'malformed'; // E3-08
    if (!first) [out, first] = [dh, bytes[0]];
    else if (!equalBytes(bytes[0], first)) return 'device_status_mismatch';
  }
  return out ? [out, hits[0].shown] : 'malformed';
}

/** A hand-built head's admitted_by record the codec would refuse is never read past. */
const admittedOK = (rec: string): boolean => {
  const p = rec.split('.');
  return p.length === 2 && isUUIDv4(p[0]) && (p[1] === '' || isUUIDv4(p[1]));
};

/**
 * The persisted device-head and the from head's retained fix, loaded into the
 * first hypothesis. Both are this module's own output (E3-08), so an
 * inconsistent device-head or a fix that does not decode is malformed. What the
 * persisted heads prove is carried, never re-opened (§2.12, D-269): a new-root
 * activation the persisted set already holds is taken, and slotFloor binds the
 * slot the from head's fix fixed.
 */
async function newWalk(c: Shared, from: DeviceHead): Promise<Walk | Reason> {
  if (
    from.realm_id !== from.chain.realm_id ||
    from.account_id !== from.chain.account_id ||
    (from.device_set.length === 0) !== (from.last_device_result.length === 0) ||
    !from.admitted_by.every(admittedOK)
  )
    return 'malformed';
  const empty = emptyDeviceSet(from.realm_id, from.account_id);
  if (!empty) return 'malformed';
  const w: Walk = {
    set: empty,
    dseq: 0,
    last: NONE,
    lastDR: NONE,
    floor: 0,
    actDone: 0,
    slotFloor: NO_FLOOR,
    admitted: new Map(from.admitted_by.map((r) => r.split('.') as [string, string])),
    secrets: [...from.secrets],
    superseded: false,
  };
  if (from.last_device_result.length === 0) return w;
  const set = await decodeAs('device-set', from.device_set);
  const dr = await decodeAs('device-result', from.last_device_result);
  if (!set || !dr || set.realm_id !== from.realm_id || set.account_id !== from.account_id)
    return 'malformed';
  // carry: the from head's new-root activation is in the persisted set exactly when its pending device is gone.
  const taken = installsRoot(c.fromPub) && set.pending === '' && dr.chain_seq === c.base;
  return {
    ...w,
    set: from.device_set,
    dseq: dr.dseq,
    last: await sha384(from.last_device_result),
    lastDR: from.last_device_result,
    floor: dr.chain_seq,
    actDone: taken ? c.base : 0,
    slotFloor: slotFloorOf(set, c.fromPub, c.fix, taken),
  };
}

// ── The view ─────────────────────────────────────────────────────────────────

/** The recovery state effective at DeviceView.asOfMs (LD-34); a pending unbind has no replacement key. */
export interface RecoveryView {
  bound: Uint8Array | null;
  bindDigest: Uint8Array;
  replacement: Uint8Array | null;
  replacementBindDigest: Uint8Array;
  replacementNbMs: number;
  unresolved: boolean; // pending at an as_of at or after replacement_nb_ms: it may complete at any later instant (V3-01)
}

/** The effective private ledger (LD-32). admitted maps device_id to its admitting actor ("" for none). */
export interface DeviceView {
  active: DevRecord[];
  pending: DevRecord | null;
  recovery: RecoveryView;
  dseq: number;
  asOfMs: number;
  admitted: Map<string, string>;
}

const emptyView = (dseq: number, asOfMs: number): DeviceView => ({
  active: [],
  pending: null,
  recovery: {
    bound: null,
    bindDigest: NONE,
    replacement: null,
    replacementBindDigest: NONE,
    replacementNbMs: 0,
    unresolved: false,
  },
  dseq,
  asOfMs,
  admitted: new Map(),
});

/**
 * A DeviceView of a set. A malformed admitted_by record yields the empty view;
 * a malformed set keeps the admitted records, as the reference's viewOf does.
 */
async function viewOf(
  set: Uint8Array,
  dseq: number,
  asOf: number,
  admitted: string[]
): Promise<DeviceView> {
  const v = emptyView(dseq, asOf);
  if (!admitted.every(admittedOK)) return v;
  const withAdmitted: DeviceView = {
    ...v,
    admitted: new Map(admitted.map((r) => r.split('.') as [string, string])),
  };
  const s = await parseSet(set);
  if (!s) return withAdmitted;
  const { v: d } = s;
  return {
    ...withAdmitted,
    active: s.act,
    pending: s.pend,
    recovery: {
      bound: d.recovery_key.length > 0 ? d.recovery_key : null,
      bindDigest: d.recovery_bind_digest,
      replacement: d.replacement_key.length > 0 ? d.replacement_key : null,
      replacementBindDigest: d.replacement_bind_digest,
      replacementNbMs: d.replacement_nb_ms,
      unresolved: asOf !== 0 && d.replacement_bind_digest.length > 0 && asOf >= d.replacement_nb_ms,
    },
  };
}

/**
 * D-S2: r is active, with exactly that dkx, in h's effective set. That is the
 * persisted set, unless h's retained fix shows the raw pending head's new-root
 * activation and the set stops before it (device-head field 7): then it is the set
 * that activation leaves (DR8), so a device the activation dropped gets no
 * wrap. A head that does not read has no active device. Never throws.
 */
export async function activeRecipient(h: DeviceHead, r: DevRecord): Promise<boolean> {
  try {
    let set: Uint8Array | null = h.device_set;
    const [raw, rr] = await headPub(h.chain);
    const fix = await fixStatus(h.chain.fix);
    if (
      rr === 'ok' &&
      fix !== 'malformed' &&
      installsRoot(raw) &&
      fixNames(fix, raw) &&
      !effectivePending(raw, fix)
    )
      set = await normalizeDeviceSet(set, { activate: true });
    if (!set) return false;
    const v = await viewOf(set, 0, 0, h.admitted_by);
    return v.active.some((e) => e.id === r.id && equalBytes(e.dkx, r.dkx));
  } catch {
    return false;
  }
}

// ── VerifyDeviceLedger ───────────────────────────────────────────────────────

/** What the server serves for one verifyDeviceLedger call. */
export interface DeviceLedgerInput {
  chainBundles: Uint8Array[];
  deviceBundles: Uint8Array[];
  status: Uint8Array;
  deviceStatus: Uint8Array;
}

/** The heads to persist (`from` on a refusal), the view, the HW and the Reason. */
export interface DeviceLedgerOutcome {
  chain: ChainHead;
  device: DeviceHead;
  view: DeviceView;
  hw: HighWater;
  reason: Reason;
}

/**
 * Re-verifies input.chainBundles from from.chain, then walks
 * input.deviceBundles (§2.12; see the invariant above). On success it returns
 * the status's state verdict; on any failure, `from` unchanged and the failing
 * Reason. `from` must come from parseDeviceHead or an earlier verification, and
 * its chain-head must be the one that verification persisted with it (D-269).
 * nowMs is the caller's clock; 0 or anything not a u is malformed. Never throws.
 */
export async function verifyDeviceLedger(
  t: Trust,
  hw: HighWater,
  from: DeviceHead,
  inp: DeviceLedgerInput,
  mem: AccountMemory,
  nowMs: number,
  use: Use
): Promise<DeviceLedgerOutcome> {
  const fail = (reason: Reason): DeviceLedgerOutcome => ({
    chain: from.chain,
    device: from,
    view: emptyView(0, 0),
    hw,
    reason,
  });
  try {
    const out = await walkLedger(t, hw, from, inp, mem, nowMs, use);
    return typeof out === 'string' ? fail(out) : out;
  } catch {
    return fail('malformed');
  }
}

async function walkLedger(
  t: Trust,
  hw: HighWater,
  from: DeviceHead,
  inp: DeviceLedgerInput,
  mem: AccountMemory,
  nowMs: number,
  use: Use
): Promise<DeviceLedgerOutcome | Reason> {
  const chain = await verifyChainSteps(
    t,
    hw,
    from.chain,
    { bundles: inp.chainBundles, status: inp.status },
    mem,
    nowMs,
    use
  );
  const st = chain.status.status;
  if (!STATE_REASONS.has(chain.reason)) return chain.reason;
  if (!st) return 'malformed';
  const [ds, dr] = await verifyDeviceStatus(t, inp.deviceStatus, st);
  if (!ds || dr !== 'ok') return dr;
  // A device-status older than τ is stale for every Use: history relaxes the
  // chain status to V, never the private ledger (DoR:919, :1120).
  const d = t.lookup(ds.delegation_gen, ds.delegation_serial);
  if (!d || sumBelow(ds.as_of_ms, d.tau_ms, nowMs)) return 'device_status_stale';
  const [hp, hr] = await headPub(chain.head);
  const [fromPub, fr] = await headPub(from.chain);
  const fix = await fixStatus(from.chain.fix);
  if (hr !== 'ok' || fr !== 'ok' || fix === 'malformed') return 'malformed';
  const c: Shared = {
    t,
    hw,
    from: from.chain,
    fromPub,
    base: from.chain.seq_index.length,
    fix,
    steps: chain.steps,
    final: effectiveOf(hp, st),
    asOf: st.as_of_ms,
    self: from.self_device_id,
  };
  const w = await newWalk(c, from);
  if (typeof w === 'string') return w;
  const entries = await parseDevices(inp.deviceBundles);
  if (!entries) return 'malformed';
  const l = new Ledger(c, w);
  const rr = await l.run(entries);
  if (rr !== 'ok') return rr;
  if (l.live[0].superseded && nowMs > st.valid_until_ms) return 'superseded_uncovered'; // T7
  const hits = await l.resolve(ds, hp, hp.seq, st.as_of_ms);
  if (typeof hits === 'string') return hits;
  const persisted = await persistOne(hits, from, chain.head);
  if (typeof persisted === 'string') return persisted;
  const [device, shown] = persisted;
  return {
    chain: chain.head,
    device,
    view: await viewOf(shown, l.live[0].dseq, ds.as_of_ms, device.admitted_by),
    hw: chain.hw,
    reason: chain.reason,
  };
}
