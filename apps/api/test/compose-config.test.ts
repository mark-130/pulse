import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const compose = readFileSync(resolve(__dirname, "../../../deploy/docker-compose.yml"), "utf8");
const dockerfile = readFileSync(resolve(__dirname, "../../../Dockerfile"), "utf8");

describe("container hardening (D58)", () => {
  it("drops every capability, blocks privilege gain, and uses a read only root with a small noexec tmpfs", () => {
    expect(compose).toMatch(/cap_drop:\n\s+- ALL/);
    expect(compose).toMatch(/no-new-privileges:true/);
    expect(compose).toMatch(/^\s+read_only: true$/m);
    expect(compose).toMatch(/tmpfs:\n\s+- \/tmp:rw,noexec,nosuid,size=\d+m/);
  });
  it("keeps what the homelab setup depends on", () => {
    expect(compose).toContain('user: "1000:1000"');
    expect(compose).toContain("/mnt/data/AppData/pulse:/data");
    expect(compose).toContain("com.centurylinklabs.watchtower.enable=true");
    expect(compose).toMatch(/networks:\n\s+- homelab/);
  });
  it("is reachable over HTTPS only (D69): the port is on loopback and the base URL is the https tailnet URL", () => {
    const ports = [...compose.matchAll(/^\s+- "([^"]*:\d+:\d+)"$/gm)].map((m) => m[1]);
    expect(ports).toEqual(["127.0.0.1:8210:8200"]);
    expect(compose).not.toMatch(/- "8210:8200"/);
    expect(compose).not.toMatch(/0\.0\.0\.0/);
    expect(compose).toContain('PULSE_BASE_URL: "https://home-lab.tail83f400.ts.net:8443"');
    expect(compose).not.toMatch(/PULSE_BASE_URL: "\$\{/);
  });
  it("no app source or UI text points at the plain LAN port (D69)", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(`${dir}/${f}`).isDirectory() ? (f === "node_modules" || f === "dist" ? [] : walk(`${dir}/${f}`)) : [`${dir}/${f}`]));
    const root = resolve(__dirname, "../../..");
    for (const file of [...walk(`${root}/apps/web/src`), ...walk(`${root}/apps/api/src`), ...walk(`${root}/packages/shared/src`)]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/:8210|192\.168\.0\.10:8210/);
    }
  });
  it("is writable only through /data: no other volume is mounted read write", () => {
    expect([...compose.matchAll(/^\s+- (\S+:\/\S+)$/gm)].map((m) => m[1] ?? "").filter((v) => !v.startsWith("/tmp") && !v.includes(":8200"))).toEqual(["/mnt/data/AppData/pulse:/data"]);
  });
  it("holds no secret value: every secret is a variable", () => {
    for (const k of ["PULSE_PASSWORD_HASH", "PULSE_SESSION_SECRET", "PULSE_SECRET_KEY", "ANTHROPIC_API_KEY", "WATCHTOWER_TOKEN", "NTFY_TOKEN"]) {
      expect(compose).toMatch(new RegExp(`${k}: "\\$\\{${k}[:}-]`));
    }
  });
  it("the Dockerfile still runs as a non-root user and states the runtime assumptions", () => {
    expect(dockerfile).toMatch(/^USER 1000:1000$/m);
    expect(dockerfile).toMatch(/read only/);
    expect(dockerfile).toMatch(/noexec/);
  });
});
