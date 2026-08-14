/**
 * skill — register the `opencontext-context` skill so the model is
 * primed on the recall/capture contract and the trust model.
 */

import { SKILL_BODY } from "./skill-body";

interface SkillService {
	register(definition: { name: string; description: string; body: string }): () => void;
}

export function registerSkill(ctx: { get: (name: string) => unknown }): () => void {
	const skill = ctx.get("skill") as SkillService | undefined;
	if (!skill || typeof skill.register !== "function") {
		return () => undefined;
	}
	return skill.register({
		name: "opencontext-context",
		description: "How the dsh-opencontext plugin surfaces durable memory and untrusted recall to the model.",
		body: SKILL_BODY,
	});
}
