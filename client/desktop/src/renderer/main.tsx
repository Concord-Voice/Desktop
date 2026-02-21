import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles/index.css';

// Apply persisted theme before React renders to prevent flash
try {
  const stored = localStorage.getItem('concord-settings');
  if (stored) {
    const { state } = JSON.parse(stored);
    const theme = state?.appearance?.theme || 'dark';
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    document.documentElement.dataset.theme = resolved;

    // Apply compact mode
    if (state?.appearance?.compactMode) {
      document.documentElement.dataset.compact = 'true';
    }

    // Apply color scheme
    const colorScheme = state?.appearance?.colorScheme;
    if (colorScheme && colorScheme !== 'concord') {
      document.documentElement.dataset.scheme = colorScheme;
    }

    // Apply font size
    const fontSize = state?.appearance?.fontSize;
    if (fontSize && fontSize !== 'default') {
      document.documentElement.dataset.fontsize = fontSize;
    }
  }
} catch {
  // Ignore parse errors, defaults will be used
}

// Clear auth tokens on startup if "Remember Me" was unchecked.
// In Electron, session cookies persist across restarts (unlike browsers),
// so we can't rely on cookie expiry alone. This is the primary mechanism
// for enforcing "don't remember me" in the desktop client.
try {
  const authStored = localStorage.getItem('concord-auth');
  if (authStored) {
    const { state } = JSON.parse(authStored);
    if (state?.rememberMe === false) {
      localStorage.removeItem('concord-auth');
    }
  }
} catch {
  // Ignore parse errors, auth will be handled normally
}

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root element not found');
}

const root = createRoot(container);

root.render(
  <React.StrictMode>
    <HashRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <App />
    </HashRouter>
  </React.StrictMode>
);
