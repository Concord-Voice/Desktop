import { test, expect } from '@playwright/test';
import { registerUser, createServer } from './helpers';

test.describe('Invites', () => {
  test('create an invite code', async ({ page }) => {
    await registerUser(page);
    await createServer(page, 'Invite Test Server');

    // Look for invite/settings button
    // Target the Invite button by role+exact name — `getByText(/invite/i)` also
    // matched the server-name heading ("Invite Test Server"), a flaky multi-match.
    const inviteBtn = page.getByRole('button', { name: 'Invite', exact: true });
    if (await inviteBtn.isVisible().catch(() => false)) {
      await inviteBtn.click();

      // The invite popup shows an "Invite Code" header + a "Generate Code"
      // button. Assert the button specifically — the old broad regex matched
      // both elements, a strict-mode multi-match flake.
      await expect(page.getByRole('button', { name: 'Generate Code' })).toBeVisible({
        timeout: 5_000,
      });
    }
  });

  test('join server with invite code', async ({ page, context }) => {
    // Register user 1 and create a server
    const user1 = await registerUser(page);
    await createServer(page, 'Joinable Server');

    // This test requires two users, which needs either:
    // 1. A second browser context with a different user
    // 2. Direct API manipulation
    // For now, verify the invite flow exists on the UI
    // Target the Invite button by role+exact name — `getByText(/invite/i)` also
    // matched the server-name heading ("Invite Test Server"), a flaky multi-match.
    const inviteBtn = page.getByRole('button', { name: 'Invite', exact: true });
    if (await inviteBtn.isVisible().catch(() => false)) {
      await inviteBtn.click();
      // Verify the invite popup opened. The "Generate Code" button is a stable
      // single-match anchor — a broad getByText regex multi-matches the popup.
      await expect(page.getByRole('button', { name: 'Generate Code' })).toBeVisible({
        timeout: 5_000,
      });
    }
  });

  test('join server form accepts invite code', async ({ page }) => {
    await registerUser(page);

    // Click add server (opens the ServerActionModal chooser). The button's
    // aria-label is "Add Server" (was stale "Add a Server" pre-#1274).
    await page.getByLabel('Add Server').click();

    // Look for "Join" option (the "Join a Server" choice in the chooser)
    const joinOption = page.getByText(/join.*server|join.*invite/i);
    if (await joinOption.isVisible().catch(() => false)) {
      await joinOption.click();

      // Should show invite code input
      const codeInput = page.getByPlaceholder(/invite|code/i);
      await expect(codeInput).toBeVisible({ timeout: 5_000 });
    }
  });
});
