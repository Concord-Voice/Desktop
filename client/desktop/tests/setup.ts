// Fix localStorage: Node 22+ provides `globalThis.localStorage` as a stub without
// working methods (setItem/getItem). Zustand persist middleware references the
// bare `localStorage` global. Replace it with a proper in-memory implementation.
{
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    writable: true,
    configurable: true,
  });
}

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Auto-cleanup after each test
afterEach(() => {
  cleanup();
});

// Provide Web Crypto API from Node 20 (jsdom lacks crypto.subtle)
if (!globalThis.crypto?.subtle) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { webcrypto } = require('node:crypto');
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

// Mock window.electron (Electron preload bridge)
Object.defineProperty(window, 'electron', {
  value: {
    getVersion: vi.fn().mockResolvedValue('0.1.0-test'),
    getPlatform: vi.fn().mockResolvedValue('darwin'),
  },
  writable: true,
});

// Mock IntersectionObserver (jsdom doesn't support it)
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
Object.defineProperty(window, 'IntersectionObserver', {
  value: MockIntersectionObserver,
  writable: true,
});

// Mock ResizeObserver (jsdom doesn't support it)
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
Object.defineProperty(window, 'ResizeObserver', {
  value: MockResizeObserver,
  writable: true,
});

// Suppress React act() warnings in test output
const originalError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('act(')) return;
  originalError(...args);
};
