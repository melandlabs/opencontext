import { describe, expect, it } from "vitest";

import {
	useCustomEvent,
	useEnterSendWithIme,
	useIsMobile,
	useLocalStorage,
	useLocalSync,
	useMobileBottomSpacing,
	useOnClickOutside,
	usePullToRefresh,
	useScrollToBottom,
} from "./index";

describe("@melandlabs/hooks exports", () => {
	it("exports every hook as a callable function", () => {
		expect(typeof useLocalStorage).toBe("function");
		expect(typeof useLocalSync).toBe("function");
		expect(typeof useIsMobile).toBe("function");
		expect(typeof useOnClickOutside).toBe("function");
		expect(typeof useCustomEvent).toBe("function");
		expect(typeof useMobileBottomSpacing).toBe("function");
		expect(typeof useEnterSendWithIme).toBe("function");
		expect(typeof usePullToRefresh).toBe("function");
		expect(typeof useScrollToBottom).toBe("function");
	});
});
