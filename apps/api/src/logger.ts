import pino, { type DestinationStream } from "pino";

export function createLogger(level = "info", destination?: DestinationStream) {
  return pino(
    {
    level,
    redact: {
      paths: [
        "req.headers.cookie",
        "req.headers.authorization",
        "password",
        "token",
        "*.token",
        "*.password",
        "*.secret",
        "*.apiKey",
        "*.ANTHROPIC_API_KEY",
        "ANTHROPIC_API_KEY",
      ],
      censor: "[redacted]",
    },
    },
    destination,
  );
}

export type Logger = ReturnType<typeof createLogger>;
