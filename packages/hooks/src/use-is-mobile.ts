"use client";

import { useEffect, useState } from "react";

const DEFAULT_BREAKPOINT = 768;

export function useIsMobile(breakpoint: number = DEFAULT_BREAKPOINT) {
  const getMatches = () => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < breakpoint;
  };

  // Initialize with false to match server-side rendering
  // Then update in useEffect to the actual value
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [isMounted, setIsMounted] = useState<boolean>(false);

  useEffect(() => {
    setIsMounted(true);
    const update = () => setIsMobile(getMatches());

    update();

    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [breakpoint]);

  // Return false during SSR and before mount, actual value after
  return isMounted ? isMobile : false;
}
