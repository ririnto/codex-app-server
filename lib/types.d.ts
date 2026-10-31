import type { z } from "zod";

/**
 * Curated tool registration with native schema-derived arguments.
 */
export interface ToolRegistry {
  /**
   * Register a tool and validate its arguments before dispatch.
   */
  registerTool: <T extends z.ZodRawShape>(
    name: string,
    config: {
      annotations?: Record<string, boolean>;
      description: string;
      inputSchema: T;
    },
    handler: (
      args: z.output<z.ZodObject<T>>,
      extra: { signal: AbortSignal }
    ) => Promise<Record<string, unknown>> | Record<string, unknown>
  ) => void;
}

/**
 * Registered tool data stored by the MCP server.
 */
export interface RegisteredTool {
  definition: { name: string } & Record<string, unknown>;
  handler: (
    args: Record<string, unknown>,
    extra: { signal: AbortSignal }
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  method?: string;
}

/**
 * Curated registry and dynamically discovered tools.
 */
export interface Registry extends Map<string, RegisteredTool>, ToolRegistry {}
