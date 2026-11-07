import pino from "pino";

export function createLogger(level = "info") {
  return pino({
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
      ],
      censor: "[redacted]",
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
