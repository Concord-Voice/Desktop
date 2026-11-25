# Voice probe transform diagnostics plan

1. Add focused regression tests for event classification, peer/stage attribution, malformed values, and positive entered frames with zero packets.
2. Replace the aggregate marker with bounded allowlisted failure records, capture the stage at event time, and preserve the runtime fail gate.
3. Add bounded camera replacement timings and document the artifact contract.
4. Run focused and existing witness tests; request exact-head CI and review. Keep the separate production E2EE repair and unexplained historical cause explicit.
