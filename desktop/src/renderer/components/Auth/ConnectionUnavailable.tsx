import React from 'react';
import '../ui/ForceUpdateOverlay.css';
import './ConnectionUnavailable.css';

/**
 * #86 §3.10 fatal boot screen: the shell exposes `connection.whoAmI` but gave this
 * document no valid identity, so it does not know which server it belongs to.
 *
 * It must never fall back to the build-time server: it reads no
 * `import.meta.env.VITE_API_*`, imports nothing that resolves a server URL, and offers
 * no action that could reach one. Rendered by `main.tsx` in place of `App`.
 */
const ConnectionUnavailable: React.FC = () => (
  <main className="connection-unavailable">
    <div className="force-update-card">
      <h1 className="force-update-title">Connection unavailable</h1>
      <p className="force-update-message">
        This window couldn&apos;t confirm which server it belongs to, so Concord won&apos;t connect
        it to any server. Quit Concord and open it again to try again.
      </p>
    </div>
  </main>
);

export default ConnectionUnavailable;
