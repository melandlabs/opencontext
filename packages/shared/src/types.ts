import type { UIMessage } from "ai";
import { z } from "zod";

export type DataPart = { type: "append-message"; message: string };

export const workspaceArtifactManifestSchema = z.object({
	version: z.literal(1),
	files: z.array(
		z.object({
			path: z.string().min(1),
			name: z.string().min(1),
			type: z.string().min(1),
			snapshotPath: z.string().min(1).optional(),
		}),
	),
});

export const messageWorkspaceSchema = z.discriminatedUnion("scope", [
	z.object({
		scope: z.literal("session"),
		artifacts: workspaceArtifactManifestSchema,
	}),
	z.object({
		scope: z.literal("execution"),
		executionId: z.string().min(1),
		artifacts: workspaceArtifactManifestSchema,
	}),
]);

export const messageMetadataSchema = z.object({
	createdAt: z.string().optional(),
	disableAction: z.boolean().optional(),
	executionKey: z.string().optional(),
	executionId: z.string().optional(),
	workspace: messageWorkspaceSchema.optional(),
	executionAnchor: z.enum(["user", "assistant"]).optional(),
	executionSource: z.string().optional(),
	executionSequence: z.number().int().positive().optional(),
	messagePhase: z.enum(["process", "final"]).optional(),
	executionStatus: z.enum(["pending", "running", "done", "error", "blocked", "interrupted"]).optional(),
	isProcessingIndicator: z.boolean().optional(),
	linkedAssistantMessageId: z.string().optional(),
	linkedUserMessageId: z.string().optional(),
	finalizedAt: z.string().optional(),
	// Server timestamp captured after user input files are materialized and
	// before the agent starts. Artifact mtime attribution should use this as the
	// lower bound when available so user inputs are not shown as assistant output.
	artifactBaselineAt: z.string().optional(),
	platformAccountId: z.uuid().optional(),
	ragDocuments: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
			}),
		)
		.optional(),
	focusedInsightIds: z.array(z.string()).optional(),
	focusedInsights: z
		.array(
			z.object({
				id: z.string(),
				title: z.string(),
				description: z.string().nullable().optional(),
				details: z.any().nullable().optional(),
				timeline: z.any().nullable().optional(),
				groups: z.array(z.string()).nullable().optional(),
				platform: z.string().nullable().optional(),
			}),
		)
		.optional(),
	// Current insight ID passed when sending messages from insight detail page (backward compatible)
	currentInsightId: z.string().optional(),
	// Referenced context events: Insights added additionally by user via "Add event", used only as context
	referencedContextInsightIds: z.array(z.string()).optional(),
	// Referenced action items (insight task id, format like insightId|bucket|index|...)
	referencedTaskIds: z.array(z.string()).optional(),
	// Referenced people (corresponds to /api/people, can be id or name)
	referencedPeople: z.array(z.object({ id: z.string().optional(), name: z.string() })).optional(),
	// Referenced channels (corresponds to integrated channel data)
	referencedChannels: z
		.array(
			z.object({
				id: z.string().optional(),
				name: z.string(),
				platform: z.string().optional(),
			}),
		)
		.optional(),
	// File references selected from workspace (taskId is usually chatId)
	workspaceFileRefs: z
		.array(
			z.object({
				taskId: z.string(),
				path: z.string(),
				name: z.string(),
			}),
		)
		.optional(),
	// Task-layer context used by the chat-first task creation flow.
	activeTaskId: z.string().optional(),
	taskCreationMode: z.boolean().optional(),
	bootstrapTaskConfig: z.boolean().optional(),
	// Marks visible continuation messages created after an authorization card is
	// granted after the original run has already ended.
	authorizationContinuation: z.boolean().optional(),
	taskIntegrationRecovery: z
		.object({
			type: z.literal("task_execution"),
			taskId: z.string().min(1),
			executionId: z.string().min(1),
			platform: z.string().min(1),
		})
		.optional(),
	onboardingIntentId: z.string().optional(),
	taskTemplate: z
		.object({
			id: z.string().optional(),
			name: z.string().optional(),
		})
		.optional(),
	// Skill action event (e.g., button click from action_buttons)
	skillAction: z
		.object({
			skillId: z.string(),
			messageId: z.string(),
			actionId: z.string(),
		})
		.optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;
export type WorkspaceArtifactManifest = z.infer<typeof workspaceArtifactManifestSchema>;
export type MessageWorkspace = z.infer<typeof messageWorkspaceSchema>;

export type CustomUIDataTypes = {
	appendMessage: string;
	loadingText: {
		content: string;
		id: string;
	};
	lifestyleImageConsent: {
		id: string;
		prompt: string;
		reason?: string;
		createdAt: string;
	};
	lifestyleImageStatus: {
		id: string;
		status: "loading" | "success" | "error";
		provider?: string;
		model?: string;
		creditsUsed?: number;
		imageCount?: number;
		error?: string;
	};
	hideLoadingText: {
		id: string;
	};
	agentPlan: {
		content: string;
		id: string;
		thought: string;
		plan: Array<{
			step: number;
			action: string;
			tool?: string | null;
		}>;
		currentStep?: number;
		requiresApproval?: boolean;
		approvalStatus?: "pending_approval" | "approved" | "rejected" | "executing";
	};
	agentPlanUpdate: {
		content: string;
		id: string;
		thought: string;
		plan: Array<{
			step: number;
			action: string;
			tool?: string | null;
		}>;
		currentStep?: number;
		requiresApproval?: boolean;
		approvalStatus?: "pending_approval" | "approved" | "rejected" | "executing";
	};
	agentStatus: {
		content: string;
		id: string;
		thought: string;
		plan: Array<{
			step: number;
			action: string;
			tool?: string | null;
		}>;
		currentStep?: number;
	};
	hideAgentStatus: {
		id: string;
	};
	insightsRefresh: {
		action: "create" | "update" | "delete";
		insightId?: string;
		insight?: {
			id: string;
			[key: string]: unknown;
		};
	};
	calendarConflictDetected: {
		insightId: string;
		conflictEvent: {
			title: string;
			startTime: string;
			endTime: string;
		};
		requestedEvent: {
			startTime: string;
			endTime: string;
		};
	};
	calendarSuggestedSlots: {
		insightId: string;
		slots: Array<{
			day: string;
			date: string;
			time: string;
			datetime: string;
			reason: string;
		}>;
	};
	// Workflow inquiry result types
	githubInquiryResult: {
		feature: string;
		repo: string;
		issues: Array<{
			number: number;
			title: string;
			author: string;
			state: string;
			labels: string[];
			createdAt: string;
			updatedAt: string;
			comments: number;
			assignees: string[];
			body: string;
			url: string;
			relatedEvents: Array<{
				type: string;
				author: string;
				timestamp: string;
				content: string;
			}>;
		}>;
		pullRequests: Array<{
			number: number;
			title: string;
			author: string;
			state: string;
			createdAt: string;
			updatedAt: string;
			reviewStatus: string;
			requestedReviewers: string[];
			body: string;
			url: string;
			checksStatus: string;
		}>;
		summary: string;
	};
	jiraInquiryResult: {
		feature: string;
		project: string;
		tickets: Array<{
			key: string;
			title: string;
			status: string;
			priority: string;
			issueType: string;
			assignee: {
				name: string;
				email: string;
				avatar: string;
			};
			reporter: {
				name: string;
				email: string;
			};
			created: string;
			updated: string;
			dueDate?: string;
			description: string;
			url: string;
			history: Array<{
				date: string;
				author: string;
				action: string;
				comment?: string;
			}>;
			subtasks?: Array<{
				key: string;
				summary: string;
				status: string;
			}>;
			linkedIssues?: Array<{
				key: string;
				type: string;
				summary: string;
			}>;
		}>;
		summary: string;
	};
	slackInquiryResult: {
		feature: string;
		channels: string[];
		discussions: Array<{
			channel: string;
			threadTs: string;
			timestamp: string;
			permalink: string;
			mainMessage: {
				author: {
					name: string;
					username: string;
					avatar: string;
					role: string;
				};
				text: string;
				reactions: Array<{
					emoji: string;
					count: number;
					users?: string[];
				}>;
			};
			threadReplies: Array<{
				author: {
					name: string;
					username: string;
					avatar: string;
					role: string;
				};
				timestamp: string;
				text: string;
				reactions?: Array<{
					emoji: string;
					count: number;
				}>;
			}>;
			context: {
				relatedTo: string[];
				mentions: string[];
				sentiment: string;
			};
		}>;
		summary: string;
	};
	// Workflow action types
	workflowActionPreview: {
		requiresConfirmation?: boolean;
		confirmed?: boolean;
		actions: Array<{
			type: "slack_message" | "jira_update";
			target: string;
			content: string;
		}>;
	};
	workflowActionResult: {
		results: Array<{
			type: string;
			target: string;
			status: string;
			message: string;
			timestamp: string;
		}>;
		eventId: string;
		eventName: string;
	};
	workflowEventBinding: {
		message: string;
		eventId: string;
		eventName: string;
		eventUrl: string;
		timeline: Array<{
			timestamp: string;
			type: string;
			description: string;
			source: string;
			sourceUrl?: string;
			details?: unknown;
		}>;
	};
	workflowEventXRay: {
		eventId: string;
		eventName: string;
		eventDescription?: string;
		timeline: Array<{
			timestamp: string;
			type: string;
			description: string;
			source: string;
			sourceUrl?: string;
			details?: unknown;
			author?: {
				name: string;
				avatar?: string;
			};
		}>;
		summary: string;
		relatedEntities?: Array<{
			type: string;
			id: string;
			title: string;
			url: string;
		}>;
	};
	missingTaskIntegrations: {
		source?: "create" | "execute";
		taskId?: string;
		missingPlatforms?: string[];
		issues?: Array<{
			category?: "notification_channel" | "source";
			platform: string;
			reason?: "not_connected" | "invalid_context_token";
			sourceRef?: {
				type: "file" | "channel" | "folder";
				name: string;
				id?: string;
				path?: string;
			};
		}>;
	};
	missingNotificationIntegrations: {
		source?: "create" | "execute";
		taskId?: string;
		missingPlatforms?: string[];
		issues?: Array<{
			category?: "notification_channel" | "source";
			platform: string;
			reason?: "not_connected" | "invalid_context_token";
			sourceRef?: {
				type: "file" | "channel" | "folder";
				name: string;
				id?: string;
				path?: string;
			};
		}>;
	};
	taskExecutionStep: {
		stepId: string;
		title: string;
		status: "started" | "running" | "completed" | "reused" | "skipped" | "blocked" | "error";
		detail?: string;
		characterId?: string;
		characterName?: string;
		childExecutionId?: string;
		timestamp?: string;
	};
	/** Interactive action buttons for skill flows (e.g., meeting summary source selection) */
	action_buttons: {
		buttons: Array<{
			id: string;
			label: string;
			emoji?: string;
		}>;
		skillId: string;
	};
	meetingAsset: {
		recordingId: string;
		title: string;
		sourceType: "recording" | "upload";
		audioSource: "mic" | "system" | "mic+system" | "uploaded_file";
		audioPath: string;
		startedAt: string;
		endedAt?: string;
		durationSeconds: number;
		creator: string;
		visibility: "private";
		template: "general" | "sales" | "customer_success" | "user_interview";
		summary: string;
		keyPoints: string[];
		actionItems: Array<{
			text: string;
			owner?: string;
			dueDate?: string;
			sourceQuote?: string;
		}>;
		participants: string[];
		decisions: string[];
		commitments: string[];
		risks: string[];
		openQuestions: string[];
		opportunities: string[];
		notableQuotes: string[];
		customerSignals: Array<{
			type: "pain" | "objection" | "budget" | "timeline" | "competitor" | "risk";
			text: string;
		}>;
		transcript: string;
		proactiveContext?: {
			employeeId: string;
			calendarEvent: {
				id: string;
				title: string;
				startTime: string;
				endTime: string;
				participants: string[];
			};
		};
	};
	meetingAnalysisFailure: {
		audioPath: string;
		fileName: string;
		recordingId: string;
		errorCode: string;
		sourceType: "recording" | "upload";
		audioSource: "mic" | "system" | "mic+system" | "uploaded_file";
		startedAt: string;
		endedAt?: string;
		durationSeconds: number;
		template: "general" | "sales" | "customer_success" | "user_interview";
		proactiveContext?: {
			employeeId: string;
			calendarEvent: {
				id: string;
				title: string;
				startTime: string;
				endTime: string;
				participants: string[];
			};
		};
	};
	/**
	 * Provider-timeout interruption. Emitted alongside an `error` part when the
	 * agent was killed mid-tool-call by an absolute wall-clock deadline (issue
	 * #356). Carries the preserved workspace path and any artifacts that did
	 * manage to land before the deadline so the chat UI can render an explicit
	 * Continue action that reuses the same workspace instead of restarting the
	 * task from scratch.
	 */
	interruption: {
		reason: "timeout";
		timeoutMs?: number;
		workspacePath?: string;
		completedArtifacts: string[];
		canResume: boolean;
	};
};

export type ChatMessage = UIMessage<MessageMetadata, CustomUIDataTypes>;

export interface Attachment {
	name: string;
	url: string;
	contentType: string;
	downloadUrl?: string;
	sizeBytes?: number;
	blobPath?: string;
	source?: string;
	expired?: boolean;
	expiredAt?: string;
	cid?: string;
	/**
	 * SHA-256 of the raw bytes, hex encoded. Identifies content independently of
	 * file name or storage path, so the same document delivered twice is
	 * recognisable as one, and an edited copy is recognisable as different.
	 */
	sha256?: string;
}

export interface ExtractedMessageInfo {
	/**
	 * Original message ID (used for deduplication and unique identification)
	 * For Telegram it's message.id
	 * For WhatsApp it's message.id or message.key.id
	 * For other platforms it's the corresponding message unique identifier
	 */
	id?: string | number;
	chatType: "private" | "group" | "channel" | "unknown";
	chatName: string;
	sender: string;
	text: string;
	timestamp: number;
	attachments?: Attachment[];
	quoted?: ExtractedMessageInfo | null;
	/**
	 * Flag whether the message is sent by current user
	 * true: message sent by me (outgoing)
	 * false: message sent by other party (incoming)
	 * undefined: unknown direction (for backward compatibility with old data or platforms that don't support direction detection)
	 */
	isOutgoing?: boolean;
}
