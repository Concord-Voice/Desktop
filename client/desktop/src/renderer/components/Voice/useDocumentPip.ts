import { useRef, useCallback, useEffect, useState } from 'react';

interface DocumentPipOptions {
  width?: number;
  height?: number;
}

/**
 * Hook that manages a Document Picture-in-Picture window.
 *
 * The Document PiP API (Chrome 116+) creates a floating window that shares
 * the same browsing context as the opener. This means MediaStreams, Zustand
 * stores, and DOM elements all work seamlessly — no BroadcastChannel or
 * serialization needed.
 *
 * Usage:
 *   const { open, close, isOpen, pipWindow } = useDocumentPip();
 *   // open() returns the PiP Window; render into it via React Portal.
 */
export function useDocumentPip() {
  const pipWindowRef = useRef<Window | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Track the pipWindow in state so consumers re-render when it changes
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  const open = useCallback(async (opts?: DocumentPipOptions): Promise<Window | null> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dPiP = (window as any).documentPictureInPicture;
    if (!dPiP) {
      console.warn('Document PiP API not available');
      return null;
    }

    try {
      const win: Window = await dPiP.requestWindow({
        width: opts?.width ?? 320,
        height: opts?.height ?? 240,
      });

      // Copy stylesheets from main document so components render correctly
      for (const sheet of document.styleSheets) {
        try {
          if (sheet.href) {
            const link = win.document.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            win.document.head.appendChild(link);
          } else if (sheet.cssRules) {
            const style = win.document.createElement('style');
            for (const rule of sheet.cssRules) {
              style.textContent += rule.cssText;
            }
            win.document.head.appendChild(style);
          }
        } catch {
          // Cross-origin stylesheet — skip
        }
      }

      // Set dark background to match app theme
      win.document.body.style.margin = '0';
      win.document.body.style.overflow = 'hidden';
      win.document.body.style.backgroundColor = 'var(--bg-primary, #1e1e2e)';

      pipWindowRef.current = win;
      setPipWindow(win);
      setIsOpen(true);

      // Clean up when PiP window is closed by user
      win.addEventListener('pagehide', () => {
        pipWindowRef.current = null;
        setPipWindow(null);
        setIsOpen(false);
      });

      return win;
    } catch (err) {
      console.error('Failed to open Document PiP:', err);
      return null;
    }
  }, []);

  const close = useCallback(() => {
    pipWindowRef.current?.close();
    pipWindowRef.current = null;
    setPipWindow(null);
    setIsOpen(false);
  }, []);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      pipWindowRef.current?.close();
    };
  }, []);

  return { open, close, isOpen, pipWindow };
}

/** Check if the Document PiP API is available in this environment */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const hasDocumentPipSupport = typeof window !== 'undefined' && !!(window as any).documentPictureInPicture;
