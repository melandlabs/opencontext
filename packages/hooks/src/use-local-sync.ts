"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Listener<T> = (value: T) => void;

/**
 * Shared store backed by localStorage that syncs across:
 * 1. Multiple components in the same session (in-process)
 * 2. Multiple tabs/windows (via localStorage events)
 *
 * @param key - The localStorage key
 * @param initialValue - The initial value if no value is stored
 */
export function useLocalSync<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const listeners = useRef<Set<Listener<T>>>(new Set());
  const isUpdating = useRef(false);
  const valueRef = useRef<T>(initialValue);
  const [storedValue, setStoredValue] = useState<T>(initialValue);

  // Get current value from localStorage or initial
  const getStoredValue = useCallback((): T => {
    if (typeof window === "undefined") return initialValue;
    try {
      const item = window.localStorage.getItem(key);
      return item !== null ? parseJSON<T>(item) : initialValue;
    } catch {
      return initialValue;
    }
  }, [key, initialValue]);

  // Sync value across all listeners and localStorage
  const sync = useCallback(
    (value: T) => {
      valueRef.current = value;
      setStoredValue(value);

      if (typeof window !== "undefined") {
        try {
          isUpdating.current = true;
          window.localStorage.setItem(key, JSON.stringify(value));
          requestAnimationFrame(() => {
            isUpdating.current = false;
          });
        } catch (error) {
          console.warn(`Error setting localStorage key "${key}":`, error);
          isUpdating.current = false;
        }
      }

      // Notify all listeners (in-process subscribers)
      listeners.current.forEach((listener) => listener(value));
    },
    [key],
  );

  // Set value function
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      const valueToStore =
        value instanceof Function ? value(valueRef.current) : value;
      sync(valueToStore);
    },
    [sync],
  );

  // Read initial value and register listener on mount
  useEffect(() => {
    const initial = getStoredValue();
    valueRef.current = initial;
    setStoredValue(initial);
  }, [getStoredValue]);

  // Listen to storage events from other tabs/windows
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (isUpdating.current) return;
      if (event.key !== key) return;

      if (event.newValue !== null) {
        const newValue = parseJSON<T>(event.newValue);
        sync(newValue);
      } else {
        sync(initialValue);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [key, initialValue, sync]);

  return [storedValue, setValue];
}

function parseJSON<T>(value: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}
