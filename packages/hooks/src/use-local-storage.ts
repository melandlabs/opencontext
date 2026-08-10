"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Custom useLocalStorage hook that properly handles SSR/hydration and avoids infinite loops.
 *
 * This implementation:
 * 1. Uses a ref to track if the component is mounted
 * 2. Only reads from localStorage after mount to avoid hydration issues
 * 3. Uses a ref to store the current value for setValue callback (avoiding storedValue dependency)
 * 4. Uses a flag to prevent storage event handler from reacting to our own localStorage writes
 *
 * @param key - The localStorage key
 * @param initialValue - The initial value if no value is stored
 * @returns A tuple of [storedValue, setValue, removeValue]
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  // Ref to track if component is mounted
  const isMounted = useRef(false);

  // Ref to track if we're updating localStorage (to prevent storage event handler from reacting to own writes)
  const isUpdating = useRef(false);

  // Ref to store current value for use in setValue callback
  const valueRef = useRef(initialValue);

  // State to store our value
  const [storedValue, setStoredValue] = useState<T>(initialValue);

  // Keep valueRef in sync with state
  useEffect(() => {
    valueRef.current = storedValue;
  }, [storedValue]);

  // Read from localStorage after mount (only runs once)
  useEffect(() => {
    if (isMounted.current) {
      return;
    }

    try {
      const item = window.localStorage.getItem(key);
      if (item !== null) {
        const parsedValue = parseJSON<T>(item);
        setStoredValue(parsedValue);
        valueRef.current = parsedValue;
      }
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
    } finally {
      isMounted.current = true;
    }
  }, [key]);

  // Listen to storage events from other tabs/windows (not from this component)
  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      // Skip events triggered by our own writes
      if (isUpdating.current) {
        return;
      }

      if (event.key === key) {
        if (event.newValue !== null) {
          const newValue = parseJSON<T>(event.newValue);
          setStoredValue(newValue);
          valueRef.current = newValue;
        } else {
          // Key was removed
          setStoredValue(initialValue);
          valueRef.current = initialValue;
        }
      }
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, [key, initialValue]);

  // Return a wrapped version of useState's setter function that persists to localStorage
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      try {
        // Allow value to be a function so we have same API as useState
        const valueToStore =
          value instanceof Function ? value(valueRef.current) : value;

        // Mark that we're updating to prevent storage event handler from reacting
        isUpdating.current = true;

        // Save to localStorage first (sync write)
        if (typeof window !== "undefined") {
          window.localStorage.setItem(key, JSON.stringify(valueToStore));
        }

        // Then update state
        setStoredValue(valueToStore);
        valueRef.current = valueToStore;

        // Reset updating flag after a tick
        requestAnimationFrame(() => {
          isUpdating.current = false;
        });
      } catch (error) {
        console.warn(`Error setting localStorage key "${key}":`, error);
        isUpdating.current = false;
      }
    },
    [key],
  );

  // Function to remove value from localStorage
  const removeValue = useCallback(() => {
    try {
      isUpdating.current = true;

      setStoredValue(initialValue);
      valueRef.current = initialValue;

      if (typeof window !== "undefined") {
        window.localStorage.removeItem(key);
      }

      requestAnimationFrame(() => {
        isUpdating.current = false;
      });
    } catch (error) {
      console.warn(`Error removing localStorage key "${key}":`, error);
      isUpdating.current = false;
    }
  }, [key, initialValue]);

  return [storedValue, setValue, removeValue];
}

/**
 * Safely parse JSON with a fallback
 */
function parseJSON<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}
