# Concord Desktop Client

Electron-based desktop application for Concord voice communication platform.

## Tech Stack

- **Electron** - Cross-platform desktop framework
- **React** - UI library
- **TypeScript** - Type-safe development
- **Vite** - Fast build tool and dev server
- **WebRTC** - Real-time voice communication

## Development

### Prerequisites

- Node.js 20+
- npm 10+

### Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev
```

The app will start with hot-reload enabled. The renderer process runs on `http://localhost:3001`.

### Available Scripts

- `npm run dev` - Start development mode with hot reload
- `npm run build` - Build for production
- `npm run package` - Package the app for distribution
- `npm run make` - Create platform-specific installers
- `npm run lint` - Run ESLint
- `npm run typecheck` - Run TypeScript type checking

## Project Structure

```
desktop/
├── src/
│   ├── main/           # Electron main process
│   │   └── main.ts    # App entry point, window management
│   ├── preload/       # Preload scripts (IPC bridge)
│   │   └── preload.ts
│   └── renderer/      # React application
│       ├── components/ # React components
│       ├── hooks/     # Custom React hooks
│       ├── store/     # State management (Zustand)
│       ├── utils/     # Utility functions
│       ├── styles/    # CSS styles
│       ├── App.tsx    # Main app component
│       └── main.tsx   # React entry point
├── index.html         # HTML template
├── package.json
├── tsconfig.json      # TypeScript config (renderer)
├── tsconfig.main.json # TypeScript config (main)
└── vite.config.ts     # Vite configuration
```

## Architecture

### Main Process
The main process (`src/main/main.ts`) handles:
- Window creation and management
- System integration
- IPC communication with renderer

### Preload Script
The preload script (`src/preload/preload.ts`) provides a secure bridge between main and renderer processes using `contextBridge`.

### Renderer Process
The renderer process is a React application that handles:
- UI rendering
- User interactions
- WebRTC connections
- State management

## Security

- **Context Isolation**: Enabled to prevent renderer access to Node.js
- **Sandbox**: Enabled for additional security
- **CSP**: Content Security Policy configured in HTML
- **No Node Integration**: Disabled in renderer for security
- **IPC**: Only whitelisted APIs exposed via preload script

## Building for Production

```bash
# Build the app
npm run build

# Create distributable packages
npm run make
```

This will create platform-specific installers in the `out/` directory.

## Features

### Phase 1A: Authentication & E2EE ✅
- User registration with E2EE key generation (RSA-OAEP **4096-bit**)
- Login with automatic key unwrapping (PBKDF2 600k iterations)
- Token management (access + refresh tokens)
- Session management with device tracking
- Password strength meter (5-tier system)
- Username validation with profanity filtering
- Secure key storage (private keys never sent to server)
- Connection selector (hosted vs self-hosted)

### Phase 1B: Channels & Text Chat ✅
- Server creation/management with icons and header images
- Channel list with E2EE indicators
- Real-time messaging via WebSocket (ticket-based auth)
- Message editing, deletion, date dividers
- Presence indicators (online/offline/typing)
- Server invites with code sharing
- Channel read states and unread badges
- Custom themes (11 theme blocks, 5 color schemes x dark/light)
- Compact mode, resizable panels, font scaling

### Phase 1C: Voice & Media ✅
- WebRTC voice channels via mediasoup SFU
- Video and screen sharing UI
- DM system with conversations and voice calls
- Friend codes and privacy controls
- Emoji picker (1800+ emoji, search, skin tones, recently used)
- Channel groups with drag-and-drop ordering
- Custom context menus
- Profile popovers
- **19 Zustand stores** for state management

### Security ✅
- Electron hardening: safeStorage, ASAR, sandbox, context isolation
- Secure IPC via preload scripts (no @electron/remote)
- CSP configured
- E2EE: AES-256-GCM message encryption, RSA-OAEP 4096-bit key wrapping

### Phase 2+ 📋
- [ ] GIF integration, file uploads, @mention tagging
- [ ] Push-to-talk with global shortcuts
- [ ] System tray integration
- [ ] Auto-updates
- [ ] Native notifications
- [ ] Lazy loading and code splitting
