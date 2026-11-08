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
  /** How much thinking the model may do. Low keeps short reports from spending the whole output budget on thinking. */
  effort?: "low" | "medium" | "high";
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

export type FailureReason = "model_not_found" | "timeout" | "rate_limited" | "overloaded" | "auth" | "rejected" | "service" | "limit" | "unreadable" | "cap" | "unknown";

/** Seconds the SDK waits for one answer before it gives up. */
export const AI_TIMEOUT_S = 60;

/** A plain reason shown under Details, and logged in the audit record. Never holds a key or a URL. */
export const FAILURE_LABELS: Record<FailureReason, string> = {
  model_not_found: "Model not found",
  timeout: `Timed out after ${AI_TIMEOUT_S} seconds`,
  rate_limited: "Rate limited",
  overloaded: "The AI service is overloaded",
  auth: "The API key was refused",
  rejected: "The request was rejected",
  service: "The AI service had an error",
  limit: "Output limit reached before the text was finished",
  unreadable: "Response could not be read",
  cap: "Cap reached",
  unknown: "The AI service failed",
};

/** A failed AI call. detail is a short sanitised line, at most 150 characters, already safe to log and show. */
export class AiFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${FAILURE_LABELS[reason]}. ${detail}` : FAILURE_LABELS[reason]);
  }
  get label(): string {
    return FAILURE_LABELS[this.reason];
  }
}
