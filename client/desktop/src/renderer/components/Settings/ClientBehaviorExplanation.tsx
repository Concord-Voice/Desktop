import React from 'react';
import {
  deriveCloseAction,
  deriveMinimizeAction,
  type CloseAction,
  type MinimizeAction,
  type ClientBehavior,
} from '../../../shared/clientBehavior';

interface Props {
  readonly clientBehavior: ClientBehavior;
}

const CLOSE_QUIT_TEXT =
  'Click the [×] button — Concord Voice will quit gracefully (saves session, closes media plane connections).';
const CLOSE_OS_QUIT_TEXT =
  'Right-click the app icon in the dock or tray and select Quit, or use your OS task manager.';
const MINIMIZE_BUTTON_TEXT = 'Click the [—] button in the title bar.';
const CLOSE_BUTTON_TEXT = 'Click the [×] button in the title bar.';
const NO_TOOLBAR_BUTTON_TEXT = 'No button is configured. Adjust your settings above to enable.';
const NO_TRAY_BUTTON_TEXT =
  'No button is configured. Select "Minimize [-]" or "Close [X]" under "To Tray" above to enable.';

function deriveToolbarText(minimizeAction: MinimizeAction, closeAction: CloseAction): string {
  if (minimizeAction === 'toolbar') return MINIMIZE_BUTTON_TEXT;
  if (closeAction === 'toolbar') return CLOSE_BUTTON_TEXT;
  return NO_TOOLBAR_BUTTON_TEXT;
}

function deriveTrayText(minimizeAction: MinimizeAction, closeAction: CloseAction): string {
  if (minimizeAction === 'tray') return MINIMIZE_BUTTON_TEXT;
  if (closeAction === 'tray') return CLOSE_BUTTON_TEXT;
  return NO_TRAY_BUTTON_TEXT;
}

export const ClientBehaviorExplanation: React.FC<Props> = ({ clientBehavior }) => {
  const closeAction = deriveCloseAction(clientBehavior);
  const minimizeAction = deriveMinimizeAction(clientBehavior);

  const closeText = closeAction === 'quit' ? CLOSE_QUIT_TEXT : CLOSE_OS_QUIT_TEXT;
  const toolbarText = deriveToolbarText(minimizeAction, closeAction);
  const trayText = deriveTrayText(minimizeAction, closeAction);

  return (
    <div className="client-behavior-explanation">
      <p>
        <strong>To Close Concord Voice:</strong> {closeText}
      </p>
      <p>
        <strong>To Minimize Concord Voice to the Toolbar:</strong> {toolbarText}
      </p>
      <p>
        <strong>To Minimize Concord Voice to the Tray:</strong> {trayText}
      </p>
    </div>
  );
};
