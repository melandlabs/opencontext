/**
 * Module shim: `@tencent-weixin/openclaw-weixin` ships compiled output at
 * `dist/src/api/types.js` but exposes no `exports` entry for it. We import
 * the runtime path to satisfy Node.js, but TypeScript (strict mode) needs
 * declarations here. This file declares the module by re-exporting types
 * from the `.ts` source path, which `moduleResolution: "bundler"` resolves.
 *
 * Workaround only — remove once upstream adds an `exports` field that maps
 * `./api/types` to the compiled output.
 */
declare module "@tencent-weixin/openclaw-weixin/dist/src/api/types.js" {
	export type {
		CDNMedia,
		FileItem,
		GetConfigResp,
		GetUpdatesResp,
		ImageItem,
		MessageItem,
		SendTypingReq,
		VideoItem,
		VoiceItem,
		WeixinMessage,
	} from "@tencent-weixin/openclaw-weixin/src/api/types";
	export {
		MessageItemType,
		MessageState,
		MessageType,
		TypingStatus,
		UploadMediaType,
	} from "@tencent-weixin/openclaw-weixin/src/api/types";
}
