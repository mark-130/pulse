import type { TokenUsage } from "./pricing.js";

/** The small slice of the model API this app uses. Tests supply a mock. The real client is in anthropic.ts. */
export type LlmBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
export type LlmUserBlock = { type: "text"; text: string } | { type: "tool_result"; tool_use_id: string; content: string };

export type LlmMessage = { role: "user"; content: string | LlmUserBlock[] } | { role: "assistant"; content: string | LlmBlock[] };

export interface LlmTool {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface LlmRequest {
  model: string;
  /** Static text. It is sent as a cached block. Nothing that changes per request goes in here. */
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens: number;
}

export interface LlmResponse {
  content: LlmBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage: TokenUsage;
}

export interface LlmClient {
  create(req: LlmRequest): Promise<LlmResponse>;
}

/** A failed model call. The message is already safe to log and show: no key, no URL. */
export class AiCallError extends Error {}
