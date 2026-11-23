# Pending key-request pagination — Design

Ad-hoc Desktop reliability fix. Scope is the renderer's pending channel-key
distribution sweep in `desktop/src/renderer/services/e2ee/e2eeService.ts`, its
unit coverage, the corresponding MSW default response, and this release note.
The server-side cursor endpoint is already available; no protocol, crypto, or
server change belongs here.

## Problem

`GET /api/v1/e2ee/pending-keys` may return `next_cursor`. The desktop client
previously processed only the first response page, leaving later recipients
without their wrapped channel keys. An empty intermediate page made that loss
especially easy to miss.

## Design

- Fetch cursor pages during one sweep, URL-encoding every cursor, and combine
  requests by channel, recipient, and key version before processing them.
- Bound each sweep to 20 pages. Process requests from successful pages even if
  a later page fails, then retry from the failed page's cursor.
- Continue past a retryable failure for one recipient, advance the page cursor,
  and remember that failure until a full sweep reaches the end and retries from
  page one. A session fence still stops all work immediately.
- Treat omitted `next_cursor` as a one-page legacy response. An expired saved
  cursor (`400`) or invalid cursor is cleared and retried from the first page;
  requests already fetched are still processed. Cursors are URL-encoded.
- Clear the saved cursor with the existing pending-operation fence.

## Acceptance criteria

- Successful pages, including an empty intermediate page, yield each unique
  request once per sweep; retryable failures are revisited on a later sweep.
- A 20-page sweep retries from its saved continuation without dropping work.
- A failed later page does not discard earlier requests. A failed recipient
  does not starve later pages and is revisited after the final cursor window.
- Session fences, legacy unpaged servers, and expired cursors retain safe outcomes.
