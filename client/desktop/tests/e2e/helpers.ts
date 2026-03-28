import { Page, expect } from '@playwright/test';

const API_BASE = 'http://localhost:8080';

/** Generate a unique username for test isolation */
export function uniqueUsername(prefix = 'e2e'): string {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `${prefix}_${suffix}`;
}

/** Generate a unique email for test isolation */
export function uniqueEmail(prefix = 'e2e'): string {
  return `${uniqueUsername(prefix)}@test.concord.chat`;
}

const TEST_PASSWORD = 'E2ETestPassword123!';

/**
 * Register a new user via the UI.
 * Navigates to the register form, fills it out, and submits.
 * Returns the username and email.
 */
export async function registerUser(
  page: Page,
  options?: { username?: string; email?: string }
): Promise<{ username: string; email: string }> {
  const username = options?.username || uniqueUsername();
  const email = options?.email || uniqueEmail();

  // Navigate to app and click register
  await page.goto('/');

  // Look for "Create one" link or register button on the connection/login page
  const createOneBtn = page.getByText('Create one');
  const registerLink = page.getByText('Register');

  if (await createOneBtn.isVisible().catch(() => false)) {
    await createOneBtn.click();
  } else if (await registerLink.isVisible().catch(() => false)) {
    await registerLink.click();
  }

  // Wait for register form
  await expect(page.getByText('Create Your Account')).toBeVisible({ timeout: 10_000 });

  // Fill form
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('your_username').fill(username);
  await page.getByPlaceholder('Create a strong password').fill(TEST_PASSWORD);
  await page.getByPlaceholder('Confirm your password').fill(TEST_PASSWORD);

  // Check age confirmation
  await page.getByText('I confirm I am at least 16 years old').click();

  // Submit
  await page.getByText('Create Account').click();

  // Wait for navigation to app
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });

  return { username, email };
}

/**
 * Login an existing user via the UI.
 */
export async function loginUser(
  page: Page,
  email: string,
  password = TEST_PASSWORD
): Promise<void> {
  await page.goto('/');

  // Wait for login form
  await expect(page.getByText('Welcome Back')).toBeVisible({ timeout: 10_000 });

  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('Enter your password').fill(password);
  await page.getByText('Sign In').click();

  // Wait for navigation to app
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

/**
 * Create a server via the UI.
 * Assumes user is already logged in.
 */
export async function createServer(page: Page, name: string): Promise<void> {
  // Click the add server button
  await page.getByLabel('Add a Server').click();

  // Wait for the modal/form
  await expect(page.getByText(/create.*server/i)).toBeVisible({ timeout: 5_000 });

  // Fill server name
  await page.getByPlaceholder(/server name/i).fill(name);

  // Submit
  await page.getByRole('button', { name: /create/i }).click();

  // Wait for server to appear
  await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });
}

/**
 * Create a channel in the current server.
 * Assumes user is already logged in and has a server selected.
 */
export async function createChannel(page: Page, name: string): Promise<void> {
  // Click "New Channel" or similar button
  const newChannelBtn = page.getByText(/new channel/i);
  await newChannelBtn.click();

  // Fill channel name
  await page.getByPlaceholder(/channel name/i).fill(name);

  // Submit
  await page.getByRole('button', { name: /create/i }).click();

  // Wait for channel to appear in sidebar
  await expect(page.getByText(name)).toBeVisible({ timeout: 10_000 });
}

/**
 * Clean up: delete a server directly via API.
 * Used for test teardown.
 */
export async function deleteServerViaAPI(accessToken: string, serverId: string): Promise<void> {
  await fetch(`${API_BASE}/api/v1/servers/${serverId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
