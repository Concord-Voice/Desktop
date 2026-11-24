# Pending channel-key throttle implementation

1. Extend the existing pending-key unit coverage to exercise multiple rows and a shared-route 429. Assert that the next signal waits for the scheduled retry and that retry starts from the interrupted cursor.
2. Propagate the throttle result from public-key fetch and key upload to the drain. Keep the retry scoped to the current session.
3. Run the pending-key unit suite, verify the change through Desktop CI, and record the fix in the changelog.
4. Promote the classified release to v0.4.0 and verify the package, lockfile, and changelog versions.
5. Record the server-first release prerequisite on the PR. Keep the release-triggering hotfix label off while the Hosted and Self-Hosted deployment checks are pending.
