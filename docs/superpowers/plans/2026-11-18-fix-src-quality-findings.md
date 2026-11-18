# Production-code quality findings sweep (2026-11-18) — plan

The design is in `docs/superpowers/specs/2026-11-18-fix-src-quality-findings-design.md`.
Branch: `fix/src-quality-findings`.

1. **Regex rewrites (security).** Change base64url, Login, ForceUpdateOverlay and
   inviteUrl so that no quantifier can backtrack. Add
   `tests/unit/utils/regexLinearRewrites.test.ts`, which checks the new code against
   the old regexes and times it on hostile input.
2. **Log injection.** In `errorMessage()`, replace control characters with spaces.
3. **CodeQL reliability.** Change MessageList (remove the dead anchor parameter),
   OverridePanel, ConversationList, the voiceService retry loops and the spike. The
   generator script stays unchanged (see the spec).
4. **Sonar style items.** Change SSOEagerUnlock (extract the failure helper),
   decideDropIndex, the `self` references in e2eeWorker, and the conditional skips in
   the e2e spec.
5. **Record each false positive and accepted finding** with its reason in SonarCloud.
   The CodeQL quality findings are closed when the new analysis runs.
6. **Verify.** Run `tsc` (renderer and main), eslint, prettier and the full unit
   suite.
7. **Review.** At Phase 4, run red-team and e2ee-reviewer on the auth, crypto and
   E2EE surfaces. At Phase 8, run the standard reviewer set.
