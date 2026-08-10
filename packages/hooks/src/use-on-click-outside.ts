import { useEffect, useRef } from "react";

/**
 * Hook to trigger callback when clicking outside
 * @param callback - Callback function triggered when clicking outside
 * @param excludeRefs - Array of element refs to exclude (clicks on these elements won't trigger callback)
 */
export function useOnClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  callback: () => void,
  excludeRefs?: React.RefObject<HTMLElement | null>[],
) {
  const callbackRef = useRef(callback);

  // Keep callback reference up-to-date
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;

      // If click is inside ref element, don't trigger callback
      if (ref.current?.contains(target)) {
        return;
      }

      // Check if in excluded refs
      if (excludeRefs) {
        for (const excludeRef of excludeRefs) {
          if (excludeRef.current?.contains(target)) {
            return;
          }
        }
      }

      callbackRef.current();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        callbackRef.current();
      }
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [ref, excludeRefs]);
}
