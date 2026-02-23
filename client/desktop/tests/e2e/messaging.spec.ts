import { test, expect } from '@playwright/test';
import { registerUser, createServer, createChannel } from './helpers';

test.describe('Messaging', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
    await createServer(page, 'Messaging Test Server');
    await createChannel(page, 'chat');
    // Select the channel
    await page.getByText('chat').click();
  });

  test('send a message', async ({ page }) => {
    const textarea = page.getByRole('textbox');
    await textarea.fill('Hello from E2E test!');
    await textarea.press('Enter');

    // Message should appear in the message list
    await expect(page.getByText('Hello from E2E test!')).toBeVisible({ timeout: 10_000 });
  });

  test('message appears in list', async ({ page }) => {
    const textarea = page.getByRole('textbox');
    await textarea.fill('Visible message');
    await textarea.press('Enter');

    // Should be in a message element
    const message = page.locator('.message').filter({ hasText: 'Visible message' });
    await expect(message).toBeVisible({ timeout: 10_000 });
  });

  test('multiple messages appear in order', async ({ page }) => {
    const textarea = page.getByRole('textbox');

    await textarea.fill('First message');
    await textarea.press('Enter');
    await expect(page.getByText('First message')).toBeVisible({ timeout: 10_000 });

    await textarea.fill('Second message');
    await textarea.press('Enter');
    await expect(page.getByText('Second message')).toBeVisible({ timeout: 10_000 });
  });

  test('empty message is not sent', async ({ page }) => {
    const textarea = page.getByRole('textbox');
    const messagesBefore = await page.locator('.message').count();

    // Try to send empty message
    await textarea.press('Enter');

    // No new message should appear
    const messagesAfter = await page.locator('.message').count();
    expect(messagesAfter).toBe(messagesBefore);
  });
});
