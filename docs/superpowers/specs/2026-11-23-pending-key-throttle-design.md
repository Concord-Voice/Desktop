# Pending channel-key throttle

The Desktop pending-key drain continues through a batch after a shared public-key lookup or key upload returns HTTP 429. Hosted and Self-Hosted apply per-user quotas to these routes. Retrying the next row immediately costs requests without clearing the throttled operation.

Treat a shared-route 429 as a signal to pause the drain until its scheduled retry. Keep the cursor at the start of the interrupted batch so pending rows can be read again. Keep the current behavior for row-local failures, pagination, and session invalidation.
