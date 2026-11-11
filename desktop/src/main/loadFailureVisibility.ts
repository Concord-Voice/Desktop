import { dialog, type BaseWindow } from 'electron';
import { closeSplash } from './splashWindow';

export function revealLoadFailure(window: BaseWindow | null, message: string): void {
  closeSplash();
  if (window && !window.isDestroyed()) {
    window.show();
  }
  dialog.showErrorBox('Concord Voice', message);
}
