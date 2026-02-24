// Server configuration — resolved from Vite env vars at build time.
// Local dev: defaults to localhost (no .env needed)
// LAN/staging: set VITE_SERVER_HOST in .env or .env.staging (e.g., "192.0.2.19")
const SERVER_HOST = import.meta.env.VITE_SERVER_HOST || 'localhost';
const API_PORT = import.meta.env.VITE_API_PORT || '8080';
const USE_TLS = import.meta.env.VITE_USE_TLS === 'true';

const protocol = USE_TLS ? 'https' : 'http';
const wsProtocol = USE_TLS ? 'wss' : 'ws';

export const API_BASE = `${protocol}://${SERVER_HOST}:${API_PORT}`;
export const WS_BASE = `${wsProtocol}://${SERVER_HOST}:${API_PORT}`;
