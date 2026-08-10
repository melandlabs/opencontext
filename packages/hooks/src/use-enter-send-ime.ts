"use client";

import { useRef, useCallback, useEffect } from "react";

/**
 * IME anti-false trigger for "Enter to send" input: don't trigger send during or shortly after IME composition
 * Avoid false triggers when selecting words/confirming in Chinese/Japanese IMEs
 * @returns handleCompositionStart, handleCompositionEnd, getEnterKeyDownHandler
 */
export function useEnterSendWithIme() {
  const isComposingOrJustEndedRef = useRef(false);
  const compositionEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const handleCompositionStart = useCallback(() => {
    if (compositionEndTimerRef.current) {
      clearTimeout(compositionEndTimerRef.current);
      compositionEndTimerRef.current = null;
    }
    isComposingOrJustEndedRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingOrJustEndedRef.current = true;
    if (compositionEndTimerRef.current) {
      clearTimeout(compositionEndTimerRef.current);
    }
    compositionEndTimerRef.current = setTimeout(() => {
      compositionEndTimerRef.current = null;
      isComposingOrJustEndedRef.current = false;
    }, 120);
  }, []);

  useEffect(() => {
    return () => {
      if (compositionEndTimerRef.current) {
        clearTimeout(compositionEndTimerRef.current);
      }
    };
  }, []);

  /**
   * Return onKeyDown handler: call onEnter on Enter without Shift when not in IME state, otherwise prevent default
   */
  const getEnterKeyDownHandler = useCallback(
    (onEnter: () => void) => (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      if (e.nativeEvent.isComposing || isComposingOrJustEndedRef.current) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      onEnter();
    },
    [],
  );

  return {
    handleCompositionStart,
    handleCompositionEnd,
    getEnterKeyDownHandler,
  };
}
