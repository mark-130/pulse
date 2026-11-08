import { z } from "zod";

const hex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `must be ${bytes * 2} hex characters`);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8200),
  DATA_DIR: z.string().min(1).default("./data"),
  PULSE_BASE_URL: z.string().url().default("http://localhost:8200"),
  PULSE_PASSWORD_HASH: z.string().regex(/^[0-9a-f]{32}:[0-9a-f]{128}$/, "must be salt:hash in hex, create it with pnpm hash-password"),
  PULSE_SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  PULSE_SECRET_KEY: hex(32),
  GARMIN_MCP_URL: z.string().url(),
  NTFY_URL: z.string().url().default("http://192.168.0.10:8090"),
  NTFY_TOPIC: z.string().min(1).default("homelab-alerts"),
  NTFY_TOKEN: z.string().default(""),
  /** Off by default. While off the confirm flow runs and is audited but nothing is sent to Garmin (D32). */
  PULSE_GARMIN_WRITES: z.enum(["on", "off"]).default("off"),
  /** Empty means AI is off. Server side only: never sent to the browser, logged, or put in a prompt. */
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_MODEL_SMART: z.string().min(1).default("claude-sonnet-5-5"),
  ANTHROPIC_MODEL_FAST: z.string().min(1).default("claude-haiku-5-5"),
  AI_MONTHLY_CAP_GBP: z.coerce.number().positive().default(5),
  /** Price tables are in USD. This is the exchange rate used to show spend in GBP. Update it when it drifts. */
  AI_USD_TO_GBP: z.coerce.number().positive().default(0.78),
  WEB_DIST: z.string().optional(),
  MIGRATIONS_DIR: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
