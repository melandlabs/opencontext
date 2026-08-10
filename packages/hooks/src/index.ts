// NOTE: @opencontext/hooks ships React-only hooks (useLocalStorage,
// useIsMobile, useOnClickOutside, useCustomEvent, useMobileBottomSpacing,
// useEnterSendWithIme, usePullToRefresh, useScrollToBottom). React and
// SWR are declared as optional peer dependencies so this package can be
// type-checked and built in non-React environments (e.g. the opencontext
// CI matrix). Host applications that consume these hooks must install
// react>=18 and swr>=2 at the application level.

export { useLocalStorage } from "./use-local-storage";
export { useLocalSync } from "./use-local-sync";
export { useIsMobile } from "./use-is-mobile";
export { useOnClickOutside } from "./use-on-click-outside";
export { useCustomEvent } from "./use-custom-event";
export { useMobileBottomSpacing } from "./use-mobile-bottom-spacing";
export { useEnterSendWithIme } from "./use-enter-send-ime";
export type {
	UsePullToRefreshOptions,
	UsePullToRefreshReturn,
} from "./use-pull-to-refresh";
export { usePullToRefresh } from "./use-pull-to-refresh";
export { useScrollToBottom } from "./use-scroll-to-bottom";
