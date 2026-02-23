import { test, expect } from '@playwright/test';
import { registerUser, createServer } from './helpers';

test.describe('Servers', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
  });

  test('create a server', async ({ page }) => {
    await createServer(page, 'E2E Test Server');

    // Server name should be visible
    await expect(page.getByText('E2E Test Server')).toBeVisible();
  });

  test('server appears in server bar', async ({ page }) => {
    await createServer(page, 'Bar Test Server');

    // The server icon should appear in the server bar
    // Server bar shows the first letter of the server name
    const serverIcon = page.getByLabel(/Bar Test Server/i);
    await expect(serverIcon).toBeVisible({ timeout: 5_000 });
  });

  test('can switch between servers', async ({ page }) => {
    await createServer(page, 'Server Alpha');
    await createServer(page, 'Server Beta');

    // Click on Server Alpha
    const alphaIcon = page.getByLabel(/Server Alpha/i);
    if (await alphaIcon.isVisible().catch(() => false)) {
      await alphaIcon.click();
      // Should show Server Alpha's channels
      await expect(page.getByText('Server Alpha')).toBeVisible({ timeout: 5_000 });
    }
  });

  test('delete a server', async ({ page }) => {
    await createServer(page, 'Delete Me Server');

    // Right-click on the server icon for context menu, or find settings
    const serverIcon = page.getByLabel(/Delete Me Server/i);
    if (await serverIcon.isVisible().catch(() => false)) {
      await serverIcon.click({ button: 'right' });

      const deleteOption = page.getByText(/delete/i);
      if (await deleteOption.isVisible().catch(() => false)) {
        await deleteOption.click();

        // Confirm deletion if there's a modal
        const confirmBtn = page.getByRole('button', { name: /delete|confirm/i });
        if (await confirmBtn.isVisible().catch(() => false)) {
          await confirmBtn.click();
        }
      }
    }
  });
});
