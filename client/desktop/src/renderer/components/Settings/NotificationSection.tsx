import React from 'react';
import { useNotificationStore } from '../../stores/notificationStore';
import { useOsPermissionStore } from '../../stores/osPermissionStore';
import ToggleSwitch from './ToggleSwitch';
import CollapsibleSection from './CollapsibleSection';

const NotificationSection: React.FC = () => {
  const enabled = useNotificationStore((s) => s.enabled);
  const volume = useNotificationStore((s) => s.volume);
  const messageSound = useNotificationStore((s) => s.messageSound);
  const mentionSound = useNotificationStore((s) => s.mentionSound);
  const dmSound = useNotificationStore((s) => s.dmSound);
  const friendRequestSound = useNotificationStore((s) => s.friendRequestSound);
  const voiceEventSounds = useNotificationStore((s) => s.voiceEventSounds);
  const suppressWhenFocused = useNotificationStore((s) => s.suppressWhenFocused);
  const desktopNotificationsEnabled = useNotificationStore((s) => s.desktopNotificationsEnabled);
  const desktopNotifyDMs = useNotificationStore((s) => s.desktopNotifyDMs);
  const desktopNotifyMentions = useNotificationStore((s) => s.desktopNotifyMentions);
  const desktopNotifyAllMessages = useNotificationStore((s) => s.desktopNotifyAllMessages);
  const doNotDisturb = useNotificationStore((s) => s.doNotDisturb);
  const quietHoursEnabled = useNotificationStore((s) => s.quietHoursEnabled);
  const quietHoursStart = useNotificationStore((s) => s.quietHoursStart);
  const quietHoursEnd = useNotificationStore((s) => s.quietHoursEnd);
  const setEnabled = useNotificationStore((s) => s.setEnabled);
  const setVolume = useNotificationStore((s) => s.setVolume);
  const setMessageSound = useNotificationStore((s) => s.setMessageSound);
  const setMentionSound = useNotificationStore((s) => s.setMentionSound);
  const setDmSound = useNotificationStore((s) => s.setDmSound);
  const setFriendRequestSound = useNotificationStore((s) => s.setFriendRequestSound);
  const setVoiceEventSounds = useNotificationStore((s) => s.setVoiceEventSounds);
  const setSuppressWhenFocused = useNotificationStore((s) => s.setSuppressWhenFocused);
  const setDesktopNotificationsEnabled = useNotificationStore(
    (s) => s.setDesktopNotificationsEnabled
  );
  const setDesktopNotifyDMs = useNotificationStore((s) => s.setDesktopNotifyDMs);
  const setDesktopNotifyMentions = useNotificationStore((s) => s.setDesktopNotifyMentions);
  const setDesktopNotifyAllMessages = useNotificationStore((s) => s.setDesktopNotifyAllMessages);
  const setDoNotDisturb = useNotificationStore((s) => s.setDoNotDisturb);
  const setQuietHoursEnabled = useNotificationStore((s) => s.setQuietHoursEnabled);
  const setQuietHoursStart = useNotificationStore((s) => s.setQuietHoursStart);
  const setQuietHoursEnd = useNotificationStore((s) => s.setQuietHoursEnd);

  const notificationPermission = useOsPermissionStore((s) => s.notifications);
  const requestOne = useOsPermissionStore((s) => s.requestOne);

  return (
    <>
      {/* Permission Banner */}
      {notificationPermission !== 'granted' && (
        <div className="settings-notification-permission-banner">
          {notificationPermission === 'not-determined' && (
            <>
              <p>Desktop notifications require permission.</p>
              <button
                className="settings-notification-permission-btn"
                onClick={() => requestOne('notifications')}
              >
                Enable Notifications
              </button>
            </>
          )}
          {notificationPermission === 'denied' && (
            <p>Notification permission was denied. Enable in system settings.</p>
          )}
        </div>
      )}

      {/* Desktop Notifications */}
      <CollapsibleSection id="section-desktop-notifications" title="Desktop Notifications">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Enable Desktop Notifications</span>
            <span className="settings-row-hint">
              {desktopNotificationsEnabled
                ? 'Enabled. You will receive desktop notifications for activity.'
                : 'Disabled. No desktop notifications will be shown.'}
            </span>
          </div>
          <ToggleSwitch
            checked={desktopNotificationsEnabled}
            onChange={setDesktopNotificationsEnabled}
            label="Enable Desktop Notifications"
          />
        </div>

        <div className="settings-row settings-row-child">
          <div className="settings-row-info">
            <span className="settings-row-label">Direct Messages</span>
          </div>
          <ToggleSwitch
            checked={desktopNotifyDMs}
            onChange={setDesktopNotifyDMs}
            disabled={!desktopNotificationsEnabled}
            label="Direct Messages"
          />
        </div>

        <div className="settings-row settings-row-child">
          <div className="settings-row-info">
            <span className="settings-row-label">@Mentions</span>
          </div>
          <ToggleSwitch
            checked={desktopNotifyMentions}
            onChange={setDesktopNotifyMentions}
            disabled={!desktopNotificationsEnabled}
            label="@Mentions"
          />
        </div>

        <div className="settings-row settings-row-child">
          <div className="settings-row-info">
            <span className="settings-row-label">All Messages</span>
          </div>
          <ToggleSwitch
            checked={desktopNotifyAllMessages}
            onChange={setDesktopNotifyAllMessages}
            disabled={!desktopNotificationsEnabled}
            label="All Messages"
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Do Not Disturb</span>
            <span className="settings-row-hint">
              {doNotDisturb
                ? 'Enabled. All notifications are suppressed.'
                : 'Disabled. Notifications are delivered normally.'}
            </span>
          </div>
          <ToggleSwitch checked={doNotDisturb} onChange={setDoNotDisturb} label="Do Not Disturb" />
        </div>
      </CollapsibleSection>

      {/* Sounds */}
      <CollapsibleSection id="section-notification-sounds" title="Sounds">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Enable Notification Sounds</span>
            <span className="settings-row-hint">
              {enabled
                ? 'Enabled. Notification sounds will play for events.'
                : 'Disabled. All notification sounds are muted.'}
            </span>
          </div>
          <ToggleSwitch
            checked={enabled}
            onChange={setEnabled}
            label="Enable Notification Sounds"
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Volume</span>
          </div>
          <div className="settings-slider-wrapper">
            <span className="settings-slider-value">{volume}%</span>
            <input
              type="range"
              className="settings-slider"
              min={0}
              max={100}
              step={1}
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="settings-row settings-row-child">
          <div className="settings-row-info">
            <span className="settings-row-label">Message sounds</span>
          </div>
          <ToggleSwitch
            checked={messageSound}
            onChange={setMessageSound}
            disabled={!enabled}
            label="Message sounds"
          />
        </div>

        <div className="settings-row settings-row-child">
          <div className="settings-row-info">
            <span className="settings-row-label">Mention sounds</span>
          </div>
          <ToggleSwitch
            checked={mentionSound}
            onChange={setMentionSound}
            disabled={!enabled}
            label="Mention sounds"
          />
        </div>

        <div className="settings-row settings-row-child">
          <div className="settings-row-info">
            <span className="settings-row-label">DM sounds</span>
          </div>
          <ToggleSwitch
            checked={dmSound}
            onChange={setDmSound}
            disabled={!enabled}
            label="DM sounds"
          />
        </div>

        <div className="settings-row settings-row-child">
          <div className="settings-row-info">
            <span className="settings-row-label">Friend request sounds</span>
          </div>
          <ToggleSwitch
            checked={friendRequestSound}
            onChange={setFriendRequestSound}
            disabled={!enabled}
            label="Friend request sounds"
          />
        </div>

        <div className="settings-row settings-row-child">
          <div className="settings-row-info">
            <span className="settings-row-label">Voice event sounds</span>
          </div>
          <ToggleSwitch
            checked={voiceEventSounds}
            onChange={setVoiceEventSounds}
            disabled={!enabled}
            label="Voice event sounds"
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Suppress when focused</span>
            <span className="settings-row-hint">
              {suppressWhenFocused
                ? 'Enabled. Sounds and notifications are hidden when the app window is focused on the relevant channel.'
                : 'Disabled. Sounds and notifications play even when the app is focused.'}
            </span>
          </div>
          <ToggleSwitch
            checked={suppressWhenFocused}
            onChange={setSuppressWhenFocused}
            label="Suppress when focused"
          />
        </div>
      </CollapsibleSection>

      {/* Quiet Hours */}
      <CollapsibleSection id="section-quiet-hours" title="Quiet Hours">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Enable Quiet Hours</span>
            <span className="settings-row-hint">
              {quietHoursEnabled
                ? 'Enabled. Notifications are suppressed during the configured time window.'
                : 'Disabled. Notifications are delivered at all hours.'}
            </span>
          </div>
          <ToggleSwitch
            checked={quietHoursEnabled}
            onChange={setQuietHoursEnabled}
            label="Enable Quiet Hours"
          />
        </div>

        {quietHoursEnabled && (
          <>
            <div className="settings-row settings-row-child">
              <div className="settings-row-info">
                <span className="settings-row-label">Start Time</span>
              </div>
              <input
                type="time"
                className="settings-time-input"
                value={quietHoursStart}
                onChange={(e) => setQuietHoursStart(e.target.value)}
              />
            </div>

            <div className="settings-row settings-row-child">
              <div className="settings-row-info">
                <span className="settings-row-label">End Time</span>
              </div>
              <input
                type="time"
                className="settings-time-input"
                value={quietHoursEnd}
                onChange={(e) => setQuietHoursEnd(e.target.value)}
              />
            </div>
          </>
        )}
      </CollapsibleSection>
    </>
  );
};

export default NotificationSection;
