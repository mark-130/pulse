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

/** A model with no price here cannot be costed, so it cannot be called (D66). There is no fallback rate. */
export class UnpricedModelError extends Error {
  constructor(readonly model: string) {
    super(`No price is known for the model "${model}", so it cannot be used.`);
  }
}

export const UNPRICED_MODEL_TEXT = "The configured AI model has no known price, so AI is switched off. Set a supported model.";

export const PRICED_MODELS: readonly string[] = Object.keys(PRICES_USD_PER_MTOK);
export const isPricedModel = (model: string): boolean => Object.hasOwn(PRICES_USD_PER_MTOK, model);

/** The one place a price is looked up. Estimation and recording both use it. Throws for an unpriced model. */
export function priceOf(model: string): ModelPrice {
  const p = Object.hasOwn(PRICES_USD_PER_MTOK, model) ? PRICES_USD_PER_MTOK[model] : undefined;
  if (!p) throw new UnpricedModelError(model);
  return p;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costGbp(model: string, u: TokenUsage, usdToGbp: number): number {
  const p = priceOf(model);
  const usd = (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheWriteTokens * p.cacheWrite + u.cacheReadTokens * p.cacheRead) / 1_000_000;
  return usd * usdToGbp;
}
