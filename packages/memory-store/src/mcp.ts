/**
 * @opencontext/memory-store/mcp — MCP server entry.
 *
 * Spawns an MCP server (stdio transport by default) that exposes the
 * memory-store as tools any MCP client (Claude Code, etc.) can invoke.
 *
 * Tools registered:
 *   - memory.searchUnified   → UnifiedMemorySearchOutput
 *   - memory.writeRawMessage → { ok: boolean }
 *   - memory.getRawMessage   → RawMessage | null
 *   - memory.health          → { ok: true }
 *
 * Usage:
 *   import { startMcpServer } from "@opencontext/memory-store/mcp";
 *   await startMcpServer({ db: { getDb }, env: { isTauriMode } });
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ZodRawShape } from "zod";
import type { MemoryStoreConfig } from "./index";
import { createRawMessageStore } from "./storage/raw-message-store";
import { createUnifiedSearch } from "./search/unified-search";
import { upsertRawMessagesToChroma } from "./storage/chroma-memory-index";

export interface StartMcpServerOptions extends MemoryStoreConfig {
  /** Server name surfaced to the MCP client. */
  name?: string;
  /** Server version surfaced to the MCP client. */
  version?: string;
}

const DEFAULT_NAME = "@opencontext/memory-store";
const DEFAULT_VERSION = "0.9.0";

export async function startMcpServer(
  options: StartMcpServerOptions = {},
): Promise<McpServer> {
  const server = new McpServer({
    name: options.name ?? DEFAULT_NAME,
    version: options.version ?? DEFAULT_VERSION,
  });

  const rawStore = createRawMessageStore({
    env: options.env,
  });
  const search = createUnifiedSearch(options.unified);

  server.tool(
    "memory.health",
    "Returns the health status of the memory store.",
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
    }),
  );

  const searchSchema: ZodRawShape = {
    userId: z.string(),
    query: z.string().min(1),
    sources: z
      .array(z.enum(["memory", "insights", "knowledge"]))
      .optional()
      .describe("Default: ['memory','insights','knowledge']"),
    limit: z.number().int().min(1).max(50).default(10),
    threshold: z.number().min(-1).max(1).default(0.7),
    botIds: z.array(z.string()).optional(),
    documentIds: z.array(z.string()).optional(),
    includeArchivedInsights: z.boolean().default(false),
    authToken: z.string().optional(),
  };

  const writeSchema: ZodRawShape = {
    userId: z.string(),
    message: z
      .object({
        id: z.string().optional(),
        messageId: z.string().optional(),
        role: z.string(),
        content: z.union([z.string(), z.array(z.unknown())]),
        platform: z.string().optional(),
        botId: z.string().optional(),
        channel: z.string().optional(),
        person: z.string().optional(),
        timestamp: z.number().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  };

  const getSchema: ZodRawShape = {
    userId: z.string(),
    messageId: z.string(),
  };

  // Zod 4 schemas are not directly assignable to the MCP SDK's
  // AnySchema (z3.ZodTypeAny | z4.$ZodType) due to TypeScript's
  // structural checks. The runtime works correctly — only the
  // static type relationship needs the explicit cast.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool(
    "memory.searchUnified",
    {
      title: "Search Unified Memory",
      description:
        "Semantic search across raw messages (always), and optionally insights and uploaded knowledge.",
      inputSchema: searchSchema as any,
    },
    async (args: unknown) => {
      const a = args as {
        userId: string;
        query: string;
        sources?: ("memory" | "insights" | "knowledge")[];
        limit?: number;
        threshold?: number;
        botIds?: string[];
        documentIds?: string[];
        includeArchivedInsights?: boolean;
        authToken?: string;
      };
      const result = await search.searchUnifiedMemory(a);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool(
    "memory.writeRawMessage",
    {
      title: "Write Raw Message",
      description: "Persist a single raw message to the user's memory store.",
      inputSchema: writeSchema as any,
    },
    async (args: unknown) => {
      const a = args as { userId: string; message: unknown };
      const manager = await rawStore.getManager();
      const result = await (manager as unknown as {
        upsertRawMessages?: (input: {
          userId: string;
          messages: unknown[];
        }) => Promise<unknown>;
      }).upsertRawMessages?.({
        userId: a.userId,
        messages: [a.message],
      });
      try {
        await upsertRawMessagesToChroma([a.message as never]);
      } catch (error) {
        console.warn("[memory-store/mcp] chroma upsert failed:", error);
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ok: true, result }) },
        ],
      };
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool(
    "memory.getRawMessage",
    {
      title: "Get Raw Message",
      description: "Fetch a single raw message by its message id.",
      inputSchema: getSchema as any,
    },
    async (args: unknown) => {
      const a = args as { userId: string; messageId: string };
      const manager = await rawStore.getManager();
      const row = await (manager as unknown as {
        getMessageById?: (messageId: string) => Promise<unknown>;
      }).getMessageById?.(a.messageId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ message: row ?? null }),
          },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

export { type MemoryStoreConfig };
