import Anthropic from "@anthropic-ai/sdk";
import { shortDetail } from "./failure-detail.js";
import { AI_TIMEOUT_S, AiFailure, type LlmBlock, type LlmClient, type LlmRequest, type LlmResponse } from "./llm.js";

/** The only place the Anthropic SDK is used. API process only, never bundled into the web app. */
export function createAnthropicClient(apiKey: string): LlmClient {
  const sdk = new Anthropic({ apiKey, timeout: AI_TIMEOUT_S * 1000, maxRetries: 1 });
  return {
    async create(req: LlmRequest): Promise<LlmResponse> {
      try {
        const res = await sdk.messages.create({
          model: req.model,
          max_tokens: req.maxTokens,
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: req.messages as Anthropic.MessageParam[],
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
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
        throw classify(err, apiKey);
      }
    },
  };
}

/** Maps an SDK error to a plain reason. Only the HTTP status and a short sanitised line are kept, never the key or the request. */
export function classify(err: unknown, apiKey: string): AiFailure {
  const status = typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" ? err.status : null;
  const name = err instanceof Error ? err.constructor.name : "";
  const detail = shortDetail(err, apiKey);
  if (name === "APIConnectionTimeoutError" || status === 408) return new AiFailure("timeout");
  if (status === 404) return new AiFailure("model_not_found", detail);
  if (status === 401 || status === 403) return new AiFailure("auth");
  if (status === 429) return new AiFailure("rate_limited");
  if (status === 529) return new AiFailure("overloaded");
  if (status !== null && status >= 500) return new AiFailure("service", `HTTP ${status}. ${detail}`.slice(0, 150));
  if (status !== null) return new AiFailure("rejected", `HTTP ${status}. ${detail}`.slice(0, 150));
  if (/timed? ?out|ETIMEDOUT/i.test(detail)) return new AiFailure("timeout");
  return new AiFailure("unknown", detail);
}
