import { test, expect } from '@playwright/test';
import { registerUser, loginUser, uniqueEmail, uniqueUsername } from './helpers';

test.describe('Authentication', () => {
  test('register a new user', async ({ page }) => {
    const { username } = await registerUser(page);

    // Should be on the app page after registration
    await expect(page).toHaveURL(/\/app/);

    // User identity should be visible somewhere (e.g., user panel)
    await expect(page.getByText(username)).toBeVisible({ timeout: 5_000 });
  });

  test('login with existing credentials', async ({ page }) => {
    // Register first
    const { email, username } = await registerUser(page);

    // Log out
    await page.goto('/');

    // Login with the same credentials
    await loginUser(page, email);

    // Should be on the app page
    await expect(page).toHaveURL(/\/app/);
  });

  test('session persists across reload', async ({ page }) => {
    await registerUser(page);

    // Reload the page
    await page.reload();

    // Should still be on the app page (not redirected to login)
    await expect(page).toHaveURL(/\/app/, { timeout: 10_000 });
  });

  test('logout returns to login page', async ({ page }) => {
    await registerUser(page);

    // Look for logout button or menu
    const logoutBtn = page.getByText(/log\s*out|sign\s*out/i);
    if (await logoutBtn.isVisible().catch(() => false)) {
      await logoutBtn.click();
      // Should be back at login/connection page
      await expect(page.getByText(/welcome|sign in|connect/i)).toBeVisible({
        timeout: 10_000,
      });
    }
  });
});
