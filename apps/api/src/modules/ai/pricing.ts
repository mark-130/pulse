/**
 * Model prices in USD per million tokens. Checked against https://platform.claude.com/docs/en/about-claude/pricing
 * on 08/11/2026. Update the table and PRICES_CHECKED_ON together when the page changes.
 * Haiku 5.5 is cheaper for prompts up to 100,000 tokens, which every call here is.
 */
export const PRICES_CHECKED_ON = "2026-11-08";

export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICES_USD_PER_MTOK: Record<string, ModelPrice> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

/** Used for a model that is not in the table, so the cap errs on the side of counting too much. */
const FALLBACK = PRICES_USD_PER_MTOK["claude-sonnet-5-5"] as ModelPrice;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costGbp(model: string, u: TokenUsage, usdToGbp: number): number {
  const p = PRICES_USD_PER_MTOK[model] ?? FALLBACK;
  const usd = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheWriteTokens * p.cacheWrite + u.cacheReadTokens * p.cacheRead) / 1_000_000;
  return usd * usdToGbp;
}
