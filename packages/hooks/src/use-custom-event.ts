import { useEffect, useRef } from "react";

/**
 * Hook to listen for a custom event
 * @param eventName - The name of the custom event to listen for
 * @param handler - The event handler function
 */
export function useCustomEvent<T = any>(
  eventName: string,
  handler: (detail: T) => void,
) {
  const handlerRef = useRef(handler);

  // Update ref on every render to ensure always using latest handler
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleEvent = (e: Event) => {
      const customEvent = e as CustomEvent<T>;
      if (customEvent.detail !== undefined) {
        handlerRef.current(customEvent.detail);
      }
    };

    window.addEventListener(eventName, handleEvent);

    return () => {
      window.removeEventListener(eventName, handleEvent);
    };
  }, [eventName]);
}
