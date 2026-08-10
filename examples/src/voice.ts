/**
 * Voice packages — @melandlabs/voice-kokoro (TTS) + @melandlabs/voice-whisper (STT).
 *
 * We only verify imports + that the entry-point classes/functions exist;
 * running them would require downloaded model weights and a working
 * audio device, which is out of scope for a smoke test.
 */

import * as voiceKokoro from "@melandlabs/voice-kokoro";
import * as voiceWhisper from "@melandlabs/voice-whisper";
import { makeCheck, runSection } from "./_helpers.ts";

export default async function testVoice() {
	await runSection("@melandlabs/voice-kokoro", async () => {
		const check = makeCheck("voice-kokoro");
		const exported = Object.keys(voiceKokoro).filter((k) => !k.startsWith("_"));
		check("module exports symbols", exported.length > 0);
	});

	await runSection("@melandlabs/voice-whisper", async () => {
		const check = makeCheck("voice-whisper");
		const exported = Object.keys(voiceWhisper).filter((k) => !k.startsWith("_"));
		check("module exports symbols", exported.length > 0);
	});
}
