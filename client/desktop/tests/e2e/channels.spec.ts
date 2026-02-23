import { test, expect } from '@playwright/test';
import { registerUser, createServer, createChannel } from './helpers';

test.describe('Channels', () => {
  test.beforeEach(async ({ page }) => {
    await registerUser(page);
    await createServer(page, 'Channel Test Server');
  });

  test('create a channel', async ({ page }) => {
    await createChannel(page, 'test-channel');

    // Channel should appear in the sidebar
    await expect(page.getByText('test-channel')).toBeVisible();
  });

  test('channel appears in channel list', async ({ page }) => {
    await createChannel(page, 'visible-channel');

    // Should be in the TEXT CHANNELS group
    await expect(page.getByText('visible-channel')).toBeVisible();
  });

  test('click channel to select it', async ({ page }) => {
    await createChannel(page, 'clickable-channel');

    // Click the channel
    await page.getByText('clickable-channel').click();

    // The channel item should have an active class or visual indicator
    const channelItem = page.locator('.channel-item.active');
    await expect(channelItem).toBeVisible({ timeout: 5_000 });
  });
});
