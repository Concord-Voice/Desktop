// Server configuration — resolved from Vite env vars at build time.
// Local dev: defaults to localhost (no .env needed)
// LAN/staging: set VITE_SERVER_HOST in .env or .env.staging (e.g., "192.0.2.19")
const SERVER_HOST = import.meta.env.VITE_SERVER_HOST || 'localhost';
const API_PORT = import.meta.env.VITE_API_PORT || '8080';
const USE_TLS = import.meta.env.VITE_USE_TLS === 'true';

const protocol = USE_TLS ? 'https' : 'http';
const wsProtocol = USE_TLS ? 'wss' : 'ws';

// Omit port when it's the default for the protocol (443 for TLS, 80 for plain)
const isDefaultPort =
  (USE_TLS && API_PORT === '443') || (!USE_TLS && API_PORT === '80');
const portSuffix = isDefaultPort ? '' : `:${API_PORT}`;

export const API_BASE = `${protocol}://${SERVER_HOST}${portSuffix}`;
export const WS_BASE = `${wsProtocol}://${SERVER_HOST}${portSuffix}`;
