import Anthropic from "@anthropic-ai/sdk";
import { sanitiseError } from "../../notify.js";
import { AiCallError, type LlmBlock, type LlmClient, type LlmRequest, type LlmResponse } from "./llm.js";

/** The only place the Anthropic SDK is used. API process only, never bundled into the web app. */
export function createAnthropicClient(apiKey: string): LlmClient {
  const sdk = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
  return {
    async create(req: LlmRequest): Promise<LlmResponse> {
      try {
        const res = await sdk.messages.create({
          model: req.model,
          max_tokens: req.maxTokens,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: req.messages as Anthropic.MessageParam[],
          ...(req.tools?.length ? { tools: req.tools as Anthropic.Tool[] } : {}),
        });
        const content: LlmBlock[] = [];
        for (const b of res.content) {
          if (b.type === "text") content.push({ type: "text", text: b.text });
          else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
        }
        const stop = res.stop_reason === "end_turn" || res.stop_reason === "tool_use" || res.stop_reason === "max_tokens" ? res.stop_reason : "other";
        return {
          content,
          stopReason: stop,
          usage: {
            inputTokens: res.usage.input_tokens,
            outputTokens: res.usage.output_tokens,
            cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
          },
        };
      } catch (err) {
        // The SDK error text can echo request details. Keep only a sanitised line, and never the key.
        const status = typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" ? ` (HTTP ${err.status})` : "";
        throw new AiCallError(`The AI service did not answer${status}. ${sanitiseError(err).replaceAll(apiKey, "[redacted]")}`.slice(0, 300));
      }
    },
  };
}
