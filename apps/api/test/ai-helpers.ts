import type { LlmBlock, LlmClient, LlmRequest, LlmResponse } from "../src/modules/ai/llm.js";

export const FAKE_KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghijklmnop";

export const usage = (o: Partial<LlmResponse["usage"]> = {}): LlmResponse["usage"] => ({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, ...o });

export const text = (t: string, u = usage()): LlmResponse => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage: u });
export const toolUse = (name: string, input: unknown = {}, id = `tu_${Math.random().toString(36).slice(2, 8)}`, u = usage()): LlmResponse => ({
  content: [{ type: "tool_use", id, name, input } as LlmBlock],
  stopReason: "tool_use",
  usage: u,
});

/** A scripted model. Never touches the network. Records every request it receives. */
export function mockLlm(handler: (req: LlmRequest, n: number) => LlmResponse | Promise<LlmResponse>): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    async create(req) {
      requests.push(req);
      return handler(req, requests.length);
    },
  };
}
