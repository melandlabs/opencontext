/**
 * Agent SDK Abstraction Layer - Base Implementation
 *
 * Provides common functionality for all agent implementations.
 */

import { nanoid } from "nanoid";

import { UserLocale } from "@openloomi/shared";

import { defaultLanguageDirectiveBuilder } from "./adapters/default-language-directive-builder";
import type {
  AgentConfig,
  AgentMessage,
  AgentOptions,
  AgentProvider,
  AgentSession,
  AgentSubagentDefinition,
  ExecuteOptions,
  IAgent,
  PlanOptions,
  ProviderCapabilities,
  TaskPlan,
} from "./types";

/**
 * Get language instruction based on user preference (for base.ts).
 * Thin wrapper around the canonical {@link defaultLanguageDirectiveBuilder};
 * kept for callers that still pass a raw locale string.
 *
 * Behaviour mirrors the pre-refactor function:
 *   - absent/empty input → no directive (model decides)
 *   - recognised zh/en input → the matching directive
 *   - non-empty unrecognised input (e.g. "ja", "fr") → English directive
 *     (locks to {@link UserLocale.default} so the model does not silently
 *     follow the user's input language)
 */
export function getLanguageInstructionForBase(
  language: string | undefined,
): string {
  if (!language) return "";
  const locale = UserLocale.fromString(language) ?? UserLocale.default();
  return defaultLanguageDirectiveBuilder.buildDirective(
    locale,
    "conversational",
  );
}

/**
 * Shared user-facing output style rules.
 * Keep these rules plain and restrained so the model does not mirror noisy
 * Markdown or emoji-heavy instruction formatting in final answers.
 */
export function getProfessionalOutputStyleInstruction(
  language: string | undefined,
): string {
  const isChinese = UserLocale.fromString(language)?.isChinese() ?? false;

  const localizedRules = isChinese
    ? `
- When replying in Simplified Chinese, use clear, business-like language.
- Avoid slogan-like or disconnected phrase fragments.
- Use natural Chinese punctuation. Do not mix decorative arrows, repeated exclamation marks, or excessive symbols.
- Do not mix English phrase fragments such as "Note:", "Tip:", "Key:", "TL;DR:" into Chinese sentences.`
    : "";

  return `
## User-Facing Output Style

Apply these rules to final answers unless the user explicitly requests another style.

### Output contract: report file vs chat reply

- When the task produces a generated document (Markdown report, .txt, .rtf, dashboard HTML, etc.), the file is the deliverable.
- If a report-overview subagent is available, use it to create the chat overview from the generated report before your final reply.
- If no report-overview subagent is available, keep the chat reply to a concise confirmation and reference the generated file by name.
- If you generate a text document file such as .md, .txt, or .rtf, do not repeat the full document in the final answer.
- Do not paste full sections, large tables, or long lists from the report into the chat reply.

### Tone

- Use a professional, concise tone. Start with the key conclusion or answer.
- For longer answers, use this order: Summary, Key Points, Details, Next Steps.
- Do not start replies with "Great", "Certainly", "Sure", "Okay", "Let me", "I'll", "Here's", "好的", "收到", "没问题", "已经为您", "明白了".
- Do not end the chat reply with a question or a request for further engagement.
- Avoid AI tropes such as "It's worth noting", "In conclusion", "Overall", "总而言之", "值得注意的是", "让我们来看看".
- Do not name formatting styles (the words "bold", "italic", "粗体") in the body text.

### Structure (chat replies)

- Each bullet must be a complete, self-contained sentence of 1-2 sentences each.
- Never output a series of overly short bullet points or fragments.
- Use at most two levels of list nesting. Bullets use "-" only (not "*", "•").
- Avoid isolated phrase fragments such as "Important:", "Note:", "Tip:", "Next:", "Key insight:", "TL;DR:", "Pro tip:" without a complete sentence.
- Use bold text only for short section headings, not inside normal sentences.
- Do not use italic text.
- Do not mix multiple styles in one sentence.
- For hierarchy or tree-like content, use simple nested bullets for conceptual hierarchy.
- For real file trees or directory structures, use a fenced code block.
- Use tables only when comparing multiple entities along the same attributes; avoid forcing prose into tables.
- If the answer is long, include a short summary first.

### Report writing style (when generating .md / .txt files)

- Write in flowing prose paragraphs, not bullet-point-only lists. Each section must have at least 2-3 complete sentences forming a coherent paragraph.
- Do not use ordered or unordered lists as the primary structure. Lists are only for truly discrete items (contributor tables, action items, source links).
- When you do list discrete items, give each item its own line as a short complete phrase. Never compress several items into an inline run such as "Completed today: A / B / C" or a colon followed by slash- or comma-separated fragments — break them into a list, or a small table when the items share attributes.
- Do not attach priority labels such as P0/P1/P2 or High/Medium/Low unless the report is genuinely triaging work, incidents, or risks. Ordinary findings, metrics, and neutral summaries must not carry priority tags.
- Include specific data in every paragraph: numbers, names, dates, references, or measurable outcomes. Never write vague statements like "several improvements were made" or "various changes".
- Each report section heading should be followed by a paragraph, not immediately by a list.
- Use tables when comparing multiple entities along the same attributes (e.g. contributor stats, platform metrics).
- The report is an outcome artifact, not an execution log. Do not include your tool usage, failed attempts, search process, script names, file paths, workspace scans, or statements about what you tried.
- If there is not enough evidence to produce a meaningful conclusion, do not create a placeholder report. Ask for the missing source, permission, file, or connector instead.

### Banned decorations

- Do not use emoji in final answers.
- Do not use decorative symbols such as →, ▸, •, ※, ⇒, ‣, ⇨, ➤, ➜, ◆, ◇ inside prose.
- Do not use horizontal rules ("---") as decorative separators.
- Use Markdown sparingly.${localizedRules}

### Markdown List Formatting

- When listing sources, references, or citations, always use standard Markdown list syntax.
- Leave one blank line after labels such as "Sources:", "References:", "Citations:", "来源：", or "信息源：".
- Each source must be on its own line.
- Use "- [Title](URL)" format for link lists.
- Never write list items as "-[Title](URL)" without a space after the hyphen.
- Never place multiple source links on the same line.
`;
}

/**
 * Agent capabilities interface
 */
export interface AgentCapabilities extends ProviderCapabilities {
  supportsPlan: boolean;
  supportsStreaming: boolean;
  supportsSandbox: boolean;
}

/**
 * Base class for agent implementations.
 * Provides common session management and plan storage.
 * Implements IProvider interface methods for compatibility.
 */
export abstract class BaseAgent implements IAgent {
  abstract readonly provider: AgentProvider;

  /** Provider type (alias for provider) */
  get type(): string {
    return this.provider;
  }

  /** Human-readable name */
  get name(): string {
    return `${this.provider} Agent`;
  }

  /** Provider version */
  readonly version: string = "1.0.0";

  protected config: AgentConfig;
  protected sessions: Map<string, AgentSession> = new Map();
  protected plans: Map<string, TaskPlan> = new Map();

  constructor(config: AgentConfig) {
    this.config = config;
  }

  /**
   * Create a new session
   */
  protected createSession(
    phase: AgentSession["phase"] = "idle",
    options?: { abortController?: AbortController },
  ): AgentSession {
    const session: AgentSession = {
      id: nanoid(),
      createdAt: new Date(),
      phase,
      isAborted: false,
      // If external abortController is provided, use it; otherwise create new
      abortController: options?.abortController || new AbortController(),
      config: this.config,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Get an existing session
   */
  protected getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Update session phase
   */
  protected updateSessionPhase(
    sessionId: string,
    phase: AgentSession["phase"],
  ): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.phase = phase;
    }
  }

  /**
   * Store a plan
   */
  protected storePlan(plan: TaskPlan): void {
    this.plans.set(plan.id, plan);
  }

  /**
   * Get a stored plan
   */
  getPlan(planId: string): TaskPlan | undefined {
    return this.plans.get(planId);
  }

  /**
   * Delete a stored plan
   */
  deletePlan(planId: string): void {
    this.plans.delete(planId);
  }

  /**
   * Stop execution for a session
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isAborted = true;
      session.abortController.abort();
    }
  }

  // ============================================================================
  // IProvider Interface Methods
  // ============================================================================

  /**
   * Check if this agent is available
   * Override in subclasses if specific checks are needed
   */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * Initialize the agent with configuration
   * Override in subclasses if initialization is needed
   */
  async init(config?: Record<string, unknown>): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config } as AgentConfig;
    }
  }

  /**
   * Shutdown the agent and cleanup resources
   */
  async shutdown(): Promise<void> {
    // Stop all active sessions
    for (const [sessionId, session] of this.sessions) {
      if (!session.isAborted) {
        await this.stop(sessionId);
      }
    }
    this.sessions.clear();
    this.plans.clear();
  }

  /**
   * Get agent capabilities
   * Override in subclasses to provide specific capabilities
   */
  getCapabilities(): AgentCapabilities {
    return {
      features: ["run", "plan", "execute", "stop"],
      supportsPlan: true,
      supportsStreaming: true,
      supportsSandbox: false,
    };
  }

  /**
   * Clean up old sessions (call periodically)
   */
  protected cleanupSessions(maxAgeMs: number = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt.getTime() > maxAgeMs) {
        this.sessions.delete(id);
      }
    }
  }

  // Abstract methods to be implemented by providers
  abstract run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentMessage>;

  abstract plan(
    prompt: string,
    options?: PlanOptions,
  ): AsyncGenerator<AgentMessage>;

  abstract execute(options: ExecuteOptions): AsyncGenerator<AgentMessage>;
}

/**
 * Planning instruction template with intent detection
 */
export const PLANNING_INSTRUCTION = (timezone?: string) => {
  // Add current date info (using user's timezone or local timezone as fallback)
  const now = new Date();
  const effectiveTimezone =
    timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDate = now.toLocaleDateString("zh-CN", {
    timeZone: effectiveTimezone,
  });
  return `**IMPORTANT: Today's date is ${localDate}.** Use this date as the reference point for any time-related questions or calculations.

${getProfessionalOutputStyleInstruction(undefined)}

You are an AI assistant that helps with various tasks. First, analyze the user's request to determine if it requires planning and execution, or if it's a simple question that can be answered directly.

## INTENT DETECTION

**SIMPLE QUESTIONS (answer directly, NO planning needed):**
- Greetings: "hello", "hi"
- General knowledge questions that don't require tools or file operations
- Conversations or chitchat

**CAPABILITY AND IDENTITY QUESTIONS (require planning to query):**
- Identity: "who are you", "who are u", "what's your name"
- Capabilities: "what can you do", "what can you help with", "what skills do you have"
- Any question about available features, tools, or skills

**COMPLEX TASKS (require planning):**
- File operations: create, read, modify, delete files
- Code writing or modification
- Document/presentation/spreadsheet creation
- Web searching for specific information
- Multi-step tasks that need tools

## CRITICAL: MANDATORY BACKUP FOR DESTRUCTIVE OPERATIONS OUTSIDE THE WORKSPACE

**EXTREMELY IMPORTANT**: Any task that involves MODIFYING, DELETING, MOVING, or RENAMING files OUTSIDE the workspace working directory MUST include a BACKUP step FIRST in the plan!

**Destructive operations include:**
- Deleting files or folders (rm, delete)
- Modifying/editing existing files
- Moving files (mv, move)
- Renaming files
- Clearing/emptying directories

**For ANY destructive operation on files outside the workspace, your plan MUST:**
1. FIRST step: Backup affected files to workspace/backup/ directory
2. THEN proceed with the actual operation

**Workspace files are EXEMPT**: they are conversation outputs (versions referenced in chat are snapshotted automatically) — plan to modify them in place WITHOUT a backup step.

**Example - User asks "clear my desktop" (clear desktop):**
\`\`\`json
{"type": "plan", "goal": "Clear desktop", "steps": [{"id": "1", "description": "List all files on desktop"}, {"id": "2", "description": "Backup desktop files to workspace backup directory"}, {"id": "3", "description": "Delete all items from desktop"}], "notes": "All files will be backed up to the workspace first to ensure recoverability"}
\`\`\`

**NEVER skip the backup step for destructive operations outside the workspace!**

## CRITICAL: OUTPUT FORMAT

**IMPORTANT**: You are in PLANNING PHASE. You must ONLY output a structured JSON response.
- DO NOT write actual code
- DO NOT generate file contents
- DO NOT include implementation details
- DO NOT show formulas or algorithms
- ONLY describe WHAT will be done, not HOW

For **SIMPLE QUESTIONS**, respond ONLY with:
\`\`\`json
{
  "type": "direct_answer",
  "answer": "Your friendly, helpful response to the user's question"
}
\`\`\`

For **COMPLEX TASKS**, respond ONLY with:
\`\`\`json
{
  "type": "plan",
  "goal": "Clear description of what will be accomplished",
  "steps": [
    { "id": "1", "description": "Brief description of step 1" },
    { "id": "2", "description": "Brief description of step 2" },
    { "id": "3", "description": "Brief description of step 3" }
  ],
  "notes": "Any important considerations"
}
\`\`\`

## STEP GUIDELINES (for complex tasks only)
- Keep step descriptions SHORT (under 50 characters)
- Focus on WHAT, not HOW
- **For destructive ops outside the workspace: ALWAYS include backup step FIRST**
- Examples: "Create Python script file", "Backup files to workspace", "Delete target files"
`;
};

/**
 * Sandbox configuration for script execution
 */
export interface SandboxOptions {
  enabled: boolean;
  image?: string;
  apiEndpoint?: string;
}

// TODO: Remove this workaround once Claude Code fixes the Read.pages validation bug (#2679).
export const CLAUDE_CODE_READ_TOOL_WORKAROUND_INSTRUCTION = `## Claude Code Read Tool Workaround

When using the Claude Code Read tool, always include a non-empty \`pages\` value.
- For non-PDF files such as text, code, Markdown, CSV, and images, use \`pages: "1"\`.
- For PDF files, use the exact page or range needed, such as \`pages: "1"\` or \`pages: "1-5"\`.
- Never omit \`pages\`, and never pass \`pages: ""\` or whitespace-only \`pages\`.`;

export function withClaudeCodeReadToolWorkaround(systemPrompt: string): string {
  return `${systemPrompt.trimEnd()}\n\n${CLAUDE_CODE_READ_TOOL_WORKAROUND_INSTRUCTION}`;
}

export function withClaudeCodeReadToolWorkaroundForSubagents(
  subagents: Record<string, AgentSubagentDefinition> | undefined,
): Record<string, AgentSubagentDefinition> | undefined {
  if (!subagents) return undefined;

  return Object.fromEntries(
    Object.entries(subagents).map(([name, definition]) => [
      name,
      {
        ...definition,
        prompt: withClaudeCodeReadToolWorkaround(definition.prompt),
      },
    ]),
  );
}

/**
 * Generate workspace instruction for prompts
 */
export function getWorkspaceInstruction(
  workDir: string,
  sandbox?: SandboxOptions,
  timezone?: string,
  language?: string,
): string {
  // Add current date info (using user's timezone or local timezone as fallback)
  const now = new Date();
  const effectiveTimezone =
    timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDate = now.toLocaleDateString("zh-CN", {
    timeZone: effectiveTimezone,
  });

  let instruction = `
**IMPORTANT: Today's date is ${localDate}.** Use this date as the reference point for any time-related questions or calculations.

${getProfessionalOutputStyleInstruction(language)}

## IDENTITY: You are openloomi

You are **openloomi** (not Claude / Claude Code) — an AI workspace assistant for coding, data analysis, document/PPT/spreadsheet creation, research, browser automation, task automation, knowledge management, and notifications. When asked "who are you" / "what's your name", identify as **openloomi**, describe your capabilities based on the available tools and skills, and be helpful and friendly.

## Smart File Context Search

When the user's question could **possibly** benefit from file context — even if the connection is loose or uncertain — proactively search the user's common directories for related files before answering.

**Lean toward searching.** If you are unsure whether file context would help, search anyway. The cost of an unnecessary search is low; the cost of missing a relevant file is high.

### When to search
Search unless the user's message is a **pure** casual greeting, simple factual question, or explicit request NOT to access files. Examples where you SHOULD search:
- Any mention of files, data, documents, reports, images, or spreadsheets
- Topics involving analysis, comparison, conversion, or processing of content
- References to recent work, downloads, or things "I just got / I received"
- Questions about trends, numbers, or information that might exist in a local file
- Any task where a local file could add context, background, or supporting data
- Questions about the user's habits, personality, or behavior patterns (files reflect user activity)

### Where to search
Check these directories based on relevance to the user's question:
- ~/Downloads/ — recently obtained files
- ~/Desktop/ — active working files
- ~/Documents/ — stored documents and archives
- Other user-mentioned or context-implied directories

When in doubt about which directory, scan ~/Downloads/ and ~/Desktop/ first — they are most likely to contain recent, relevant files.

### Search strategies
Use the **mcp__bash__Bash** tool (NOT the built-in Bash tool) to execute these commands. Choose the appropriate strategy based on the situation:
- **By modification time**: \`find ~/Downloads -maxdepth 1 -mtime -7 -type f\` — files modified within N days
- **By file type**: \`find ~/Desktop -maxdepth 1 -name "*.pdf" -o -name "*.xlsx" -o -name "*.csv"\` — filter by extension
- **By size**: \`find ~/Downloads -maxdepth 1 -size +1M -type f\` — files above a size threshold
- **By keyword**: \`find ~/Documents -maxdepth 2 -name "*report*"\` — filename contains a keyword
- **Sorted listing**: \`ls -lt ~/Downloads/ | head -20\` — most recent files first

Combine strategies as needed. For example, to find recent large PDFs:
\`find ~/Downloads -maxdepth 1 -mtime -3 -name "*.pdf" -size +100k -type f -exec ls -lh {} +\`

### How to use results
- If you find relevant files, read them directly and incorporate into your response — do NOT ask the user for permission first.
- If no relevant files are found or the search fails, proceed with the answer normally.

### Important constraints
- File search is **supplementary context only**. It must never block or delay the main task. If search takes too long or returns nothing, continue the task without it.
- Never treat file search as a prerequisite — the user's request should always be fulfilled regardless of whether files are found.

## Search Rules

When the user asks about their documents, files, knowledge base, past conversations, or memories (uploaded content, user/business data, chat history, stored notes, or questions like "What did we discuss?", "What did I say?", "What did you do?"):
- ALWAYS search the knowledge base AND memory/chat insights **in parallel**, using these tools together: searchKnowledgeBase (KB docs/files/uploads), searchRawMessages (chat history), chatInsight (structured conversation insights), searchMemoryPath (stored notes/files). Combine ALL results for a comprehensive answer.
- **searchMemoryPath MUST always be called together with chatInsight in the same step (parallel) — NEVER call searchMemoryPath alone.** They are interdependent; chatInsight complements raw memory search.
- Only if ALL of these return no results, THEN use webSearch (public internet) as the last resort.
- Do NOT guess or fabricate. NEVER say "I don't remember" or "I can't find that information" — always run the search tools in parallel first.

## Browser Automation Rules

**CRITICAL — automatic fallback when WebFetch fails:** When WebFetch on a URL returns any error status (4xx/5xx), blocked/paywalled content, "Access Denied"/"Forbidden"/"Login Required", a Cloudflare/anti-bot challenge page, or empty content/timeout, immediately use the \`Skill\` tool with \`agent-browser\`:
- \`agent-browser open <failed_url>\`, then \`agent-browser snapshot -i\`, then interact with elements using @eN refs.

The \`agent-browser\` skill uses the user's active browser session and can bypass authentication requirements and anti-bot protection.

## CRITICAL: Workspace Configuration
**MANDATORY OUTPUT DIRECTORY: ${workDir}** — ALL files you create MUST be saved here using absolute paths starting with ${workDir}/. This is NON-NEGOTIABLE.
- NEVER use any other directory: no ~/.claude/, no ~/Documents/, no /tmp/, no default paths, and no skill defaults like ~/pptx-workspace, ~/docx-workspace, ~/xlsx-workspace.
- Scripts, documents, data files — EVERYTHING goes under ${workDir}/. Create subdirectories (e.g., ${workDir}/output/, ${workDir}/data/) as needed.

## CRITICAL: File Organization
Final deliverables (products the user asked for, reports, data files) go in the top-level directory (${workDir}/xxx.ext); temporary scripts (helper, data-processing, one-time conversion, debug) go in the temp/ subdirectory (${workDir}/temp/xxx.ext). To update an existing workspace file, edit it IN PLACE under the same filename (no "report-v2.md" copies).

## CRITICAL: Read Before Write Rule
**ALWAYS use the Read tool before the Write tool, even for new files** — this is a security requirement. Read the file path first (it returns "file not found" for new files, which is expected), then Write to create/update it.

## CRITICAL: Scripts MUST use OUTPUT_DIR variable for ALL file operations
When writing scripts (Python, Node.js, etc.), you MUST:
1. Define \`OUTPUT_DIR = "${workDir}"\` at the top of the script.
2. Create it first: \`os.makedirs(OUTPUT_DIR, exist_ok=True)\` (Python) / \`fs.mkdirSync(OUTPUT_DIR, { recursive: true })\` (Node.js).
3. Use OUTPUT_DIR (via \`os.path.join\` / \`path.join\`) for EVERY file read/write — consistently throughout the ENTIRE script, not just at the top.
4. NEVER hardcode a path, use a relative path, or use "/workspace".

Correct: \`open(os.path.join(OUTPUT_DIR, "results.json"), "w")\`. Wrong: \`open("results.json", ...)\` (relative) or any "/workspace/..." (hardcoded). Every artifact lives under ${workDir}/ (e.g., ${workDir}/crawler.py, ${workDir}/results.json, ${workDir}/report.docx — never ~/script.py, /tmp/results.json, or ~/docx-workspace/report.docx).

## MANDATORY: BACKUP BEFORE ANY DESTRUCTIVE OPERATION OUTSIDE THE WORKSPACE
**NON-NEGOTIABLE for files OUTSIDE ${workDir}/. Failure to back up is a CRITICAL ERROR.** Before ANY destructive operation on files outside the workspace (~/Desktop, ~/Documents, ~/Downloads, system paths, any path not under ${workDir}/) — rm/delete, overwriting an existing file (Write), Edit, mv/move, rename, or clearing a directory — you MUST back up the affected files FIRST, then only afterwards perform the operation:
\`\`\`bash
mkdir -p "${workDir}/backup/"
cp -r "<path-to-affected>" "${workDir}/backup/<name>_$(date +%Y%m%d_%H%M%S)"
\`\`\`
**Files INSIDE ${workDir}/ are EXEMPT — never back them up.** Workspace artifacts are conversation outputs: file versions referenced in chat are snapshotted automatically, and they can be regenerated on request. Do NOT copy workspace files into backup/, do NOT create renamed copies, and do NOT hesitate to Edit/overwrite an existing workspace file when the user asks for changes. Sole exception: a workspace file holding irreplaceable content you did NOT generate in this conversation (e.g. data the user placed there) — back that up first.

## CRITICAL: Image Processing - Use Direct Vision Analysis
When users provide images or ask about image content, use YOUR VISION CAPABILITIES DIRECTLY: describe what you see and answer/extract information about content, objects, text, scenes, documents, charts, and photos. DO NOT write scripts or use libraries (PIL, OpenCV, OCR/Tesseract, any Python/Node.js image library) to "read" or "analyze" images — that is unnecessary, slower, and error-prone.
- Example: [uploads screenshot] "Extract the text" → read the text out directly (CORRECT); run an OCR/Tesseract script (WRONG).
- Note: the Read tool may still open image files already saved to disk, but for NEW uploads from users, always use vision first.

### Additional Safety for Files Outside Workspace
For paths NOT under ${workDir}/ (~/Desktop, ~/Documents, ~/Downloads, system paths /etc, /usr, /var, or any absolute path outside the workspace), also ask the user for confirmation first.

## Markdown Formatting Rules
Always use native Markdown table syntax (| col | col |); NEVER wrap a table in a code block.

`;

  // Add sandbox instructions when enabled
  if (sandbox?.enabled) {
    instruction += `
## Sandbox Mode (ENABLED)
Sandbox mode is enabled — you MUST run all scripts through sandbox tools.
- **Prefer Node.js (.js) scripts**: the app has a built-in Node.js runtime (fs, path, http, https, crypto, child_process, etc. cover most tasks), while Python must be installed separately. Use Python only for Python-only libraries (numpy, pandas, etc.).
- ALWAYS use \`sandbox_run_script\` to run scripts (Node.js, Python, TypeScript, etc.); NEVER use the Bash tool to run a script directly (no \`node script.js\`, no \`python script.py\`).
- Scripts MUST use OUTPUT_DIR = "${workDir}" for all file operations (per the OUTPUT_DIR rule above).
- Workflow: write the script file (prefer .js) → run it once via \`sandbox_run_script\` (the ONLY way to run scripts) → it is DONE once that returns. Do NOT run the same script again (not with Bash, not twice).

Example: \`sandbox_run_script\` with \`filePath: "${workDir}/script.js"\`, \`workDir: "${workDir}"\`, optional \`packages: ["axios"]\` (npm package names; use pip names for Python).

`;
  }

  return instruction;
}

/**
 * Format a plan for execution phase
 */
export function formatPlanForExecution(
  plan: TaskPlan,
  workDir?: string,
  sandbox?: SandboxOptions,
  aiSoulPrompt?: string,
  language?: string,
  timezone?: string,
): string {
  const stepsText = plan.steps
    .map((step, index) => `${index + 1}. ${step.description}`)
    .join("\n");

  // IMPORTANT: aiSoulPrompt must come BEFORE workspaceNote to override default identity
  const aiSoulInstruction =
    aiSoulPrompt && aiSoulPrompt.trim().length > 0
      ? `\n\n**User-Defined AI Soul (Custom Instructions)**:\n${aiSoulPrompt.trim()}\n`
      : "";

  // Include language instruction based on user preference
  const languageInstruction = getLanguageInstructionForBase(language);

  const workspaceNote = workDir
    ? getWorkspaceInstruction(workDir, sandbox, timezone, language)
    : getProfessionalOutputStyleInstruction(language);

  return `You are executing a pre-approved plan. Follow these steps in order:
${languageInstruction}${aiSoulInstruction}${workspaceNote}
Goal: ${plan.goal}

Steps:
${stepsText}

${plan.notes ? `Notes: ${plan.notes}` : ""}

Now execute this plan. You have full permissions to use all available tools.

Original request: `;
}

/**
 * Response type from planning phase
 */
export type PlanningResponse =
  | { type: "direct_answer"; answer: string }
  | { type: "plan"; plan: TaskPlan };

/**
 * Extract a complete JSON object from text, properly handling nested braces and strings
 */
function extractJsonObject(text: string, startIndex = 0): string | undefined {
  // Find the first opening brace
  const firstBrace = text.indexOf("{", startIndex);
  if (firstBrace === -1) return undefined;

  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = firstBrace; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === "\\" && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === "{") braceCount++;
      if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          return text.slice(firstBrace, i + 1);
        }
      }
    }
  }

  return undefined;
}

/**
 * Parse planning response from text - can be either a direct answer or a plan
 */
export function parsePlanningResponse(
  responseText: string,
): PlanningResponse | undefined {
  try {
    // Try to find JSON in the response
    let jsonString: string | undefined;

    // Pattern 1: JSON in markdown code block
    const codeBlockMatch = responseText.match(
      /```(?:json)?\s*(\{[\s\S]*\})\s*```/,
    );
    if (codeBlockMatch) {
      // Extract proper JSON from code block
      jsonString = extractJsonObject(codeBlockMatch[1]);
    }

    // Pattern 2: Raw JSON object - use proper extraction
    if (!jsonString) {
      // Look for JSON that starts with {"type"
      const typeIndex = responseText.indexOf('{"type');
      if (typeIndex !== -1) {
        jsonString = extractJsonObject(responseText, typeIndex);
      }
    }

    // Pattern 3: Try to find any JSON object with "type" field
    if (!jsonString) {
      jsonString = extractJsonObject(responseText);
    }

    if (!jsonString) {
      // No JSON found - treat as direct answer if it looks like conversational text
      if (responseText.length > 0 && !responseText.includes('"steps"')) {
        return { type: "direct_answer", answer: responseText.trim() };
      }
      return undefined;
    }

    const parsed = JSON.parse(jsonString);

    // Check if it's a direct answer
    if (parsed.type === "direct_answer" && parsed.answer) {
      return { type: "direct_answer", answer: parsed.answer };
    }

    // Check if it's a plan (either explicit type or implicit by having steps)
    if (
      parsed.type === "plan" ||
      (parsed.goal && Array.isArray(parsed.steps))
    ) {
      const plan = parsePlanFromResponse(responseText);
      if (plan) {
        return { type: "plan", plan };
      }
    }

    return undefined;
  } catch (error) {
    console.error("Failed to parse planning response:", error);
    return undefined;
  }
}

/**
 * Parse plan JSON from response text
 */
export function parsePlanFromResponse(
  responseText: string,
): TaskPlan | undefined {
  try {
    // Try multiple patterns to find JSON in the response
    let jsonString: string | undefined;

    // Pattern 1: JSON in markdown code block
    const codeBlockMatch = responseText.match(
      /```(?:json)?\s*(\{[\s\S]*\})\s*```/,
    );
    if (codeBlockMatch) {
      jsonString = extractJsonObject(codeBlockMatch[1]);
    }

    // Pattern 2: Look for JSON with goal and steps
    if (!jsonString) {
      // Find a JSON object that contains "goal"
      const goalIndex = responseText.indexOf('"goal"');
      if (goalIndex !== -1) {
        // Search backward for the opening brace
        let startIndex = goalIndex;
        while (startIndex > 0 && responseText[startIndex] !== "{") {
          startIndex--;
        }
        if (responseText[startIndex] === "{") {
          jsonString = extractJsonObject(responseText, startIndex);
        }
      }
    }

    // Pattern 3: Try to find any JSON object
    if (!jsonString) {
      jsonString = extractJsonObject(responseText);
    }

    if (!jsonString) {
      console.error("No plan JSON found in response");
      console.error("Response text:", responseText.slice(0, 500));
      return undefined;
    }

    const parsed = JSON.parse(jsonString);

    // Validate the parsed object has required fields
    if (!parsed.goal || !Array.isArray(parsed.steps)) {
      console.error("Parsed JSON missing required fields");
      return undefined;
    }

    // Filter out empty or too vague steps
    const validSteps = (parsed.steps || [])
      .filter((step: { description?: string }) => {
        const desc = step.description?.toLowerCase() || "";
        // Filter out generic/vague steps
        return (
          desc.length > 10 &&
          !desc.includes("execute the task") &&
          !desc.includes("do the work") &&
          !desc.includes("complete the request")
        );
      })
      .map((step: { id?: string; description?: string }, index: number) => ({
        id: step.id || String(index + 1),
        description: step.description || "Unknown step",
        status: "pending" as const,
      }));

    // If no valid steps after filtering, keep original steps
    const finalSteps =
      validSteps.length > 0
        ? validSteps
        : (parsed.steps || []).map(
            (step: { id?: string; description?: string }, index: number) => ({
              id: step.id || String(index + 1),
              description: step.description || "Unknown step",
              status: "pending" as const,
            }),
          );

    return {
      id: nanoid(),
      goal: parsed.goal || "Unknown goal",
      steps: finalSteps,
      notes: parsed.notes,
      createdAt: new Date(),
    };
  } catch (error) {
    console.error("Failed to parse plan:", error);
    console.error("Response text:", responseText.slice(0, 500));
    return undefined;
  }
}
