import { useEffect, useState } from "react";

/**
 * Mobile bottom spacing hook
 * Directly measures actual height of bottom navigation bar
 */
export function useMobileBottomSpacing(): number {
  const [spacing, setSpacing] = useState(80); // Default: sufficiently large value

  useEffect(() => {
    const calculateSpacing = () => {
      // Try to find mobile bottom navigation bar
      const nav = document.querySelector(
        'nav[aria-label*="navigation"], nav[aria-label*="Navigation"]',
      );
      if (!nav) {
        // Navigation bar not found, use conservative estimate
        const safeAreaBottom = getSafeAreaInsetBottom();
        setSpacing(60 + safeAreaBottom);
        return;
      }

      // Get actual height of navigation bar
      const rect = nav.getBoundingClientRect();
      const navHeight = rect.height;

      // Total spacing = actual navigation bar height + additional buffer
      const totalSpacing = navHeight + 8;

      setSpacing(totalSpacing);
    };

    // Delayed execution to ensure DOM is rendered
    const timer = setTimeout(calculateSpacing, 100);

    // Listen for window size changes (e.g., device rotation)
    window.addEventListener("resize", calculateSpacing);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", calculateSpacing);
    };
  }, []);

  return spacing;
}

/**
 * Get safe-area-inset-bottom value
 */
function getSafeAreaInsetBottom(): number {
  if (typeof window === "undefined") return 0;

  // Create a temporary element to measure safe-area-inset-bottom
  const div = document.createElement("div");
  div.style.position = "fixed";
  div.style.left = "0";
  div.style.bottom = "0";
  div.style.width = "0";
  div.style.height = "0";
  div.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
  div.style.visibility = "hidden";
  div.style.pointerEvents = "none";

  document.body.appendChild(div);

  // Get computed padding-bottom value
  const computedStyle = window.getComputedStyle(div);
  const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;

  // Cleanup temporary element
  document.body.removeChild(div);

  return paddingBottom;
}
