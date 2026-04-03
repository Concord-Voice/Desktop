import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';

interface UseResizablePanelOptions {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** 'left' = drag handle is on the right edge, 'right' = drag handle is on the left edge */
  side: 'left' | 'right';
  storageKey?: string;
}

export function useResizablePanel({
  defaultWidth,
  minWidth,
  maxWidth,
  side,
  storageKey,
}: UseResizablePanelOptions) {
  const [width, setWidth] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = Number.parseInt(saved, 10);
        if (!Number.isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) return parsed;
      }
    }
    return defaultWidth;
  });

  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = e.clientX - startX.current;
      const newWidth = side === 'left' ? startWidth.current + delta : startWidth.current - delta;
      const clamped = Math.max(minWidth, Math.min(maxWidth, newWidth));
      setWidth(clamped);
    };

    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (storageKey) {
        // Persist after drag ends — read latest width from DOM to avoid stale closure
        setWidth((current) => {
          localStorage.setItem(storageKey, String(current));
          return current;
        });
      }
    };

    globalThis.addEventListener('mousemove', onMouseMove);
    globalThis.addEventListener('mouseup', onMouseUp);
    return () => {
      globalThis.removeEventListener('mousemove', onMouseMove);
      globalThis.removeEventListener('mouseup', onMouseUp);
    };
  }, [minWidth, maxWidth, side, storageKey]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      let step = 0;
      const large = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowRight') {
        step = (side === 'left' ? 10 : -10) * large;
      } else if (e.key === 'ArrowLeft') {
        step = (side === 'left' ? -10 : 10) * large;
      } else {
        return;
      }
      e.preventDefault();
      setWidth((prev) => {
        const next = Math.max(minWidth, Math.min(maxWidth, prev + step));
        if (storageKey) localStorage.setItem(storageKey, String(next));
        return next;
      });
    },
    [side, minWidth, maxWidth, storageKey]
  );

  return { width, onMouseDown, onKeyDown };
}
