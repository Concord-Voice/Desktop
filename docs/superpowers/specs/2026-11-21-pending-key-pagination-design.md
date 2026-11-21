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
- Bound each sweep to 20 pages. Save the continuation only after every fetched
  request has processed; schedule the existing retry to resume the next page.
- Preserve the existing generation fence and stop behavior. A stopped request
  restarts the uncommitted sweep rather than advancing the cursor.
- Treat omitted `next_cursor` as a one-page legacy response. An expired saved
  cursor (`400`) is cleared and retried from the first page. Invalid cursors
  are rejected locally and never interpolated unencoded into a URL.
- Clear the saved cursor with the existing pending-operation fence.

## Acceptance criteria

- All pages, including an empty intermediate page, yield each unique request
  exactly once.
- A 20-page sweep retries from its saved continuation without dropping work.
- Session fences, stop/retry behavior, legacy unpaged servers, and expired
  cursors retain their prior safe outcomes.
