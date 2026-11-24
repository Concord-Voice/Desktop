# Voice probe transform diagnostics

Desktop#244 identifies a runtime-probe attribution gap. A single failure boolean discards the triggering event, peer, and stage; the verifier also rejects an entered-frame verdict when the packet sample is zero even though production accepts it. Historical failures cannot be attributed from their boolean alone.

Retain only bounded, fixed reason codes with peer index and event-time stage. Preserve every existing failure trigger and the runtime failure gate, retain no raw console content or IDs, and accept a valid positive entered-frame count regardless of packet count. Record bounded call timings during camera replacement. This probe-only slice leaves production E2EE logic and its separately tracked per-attachment and sampling issues unchanged.

Acceptance: focused tests cover each event, asynchronous malformed/throwing payloads, zero-packet positive entry, bounded records and failure gating; the existing witness contract suite remains green. Actual runtime CI remains required to validate real Electron and media behavior.
