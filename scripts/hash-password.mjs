// Usage: read -rs p; printf %s "$p" | pnpm hash-password
import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";

const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (!password) {
  console.error("No password on stdin.");
  process.exit(1);
}
const salt = randomBytes(16);
console.log(`${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`);
