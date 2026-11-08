import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { APP_NAME, DRY_RUN_TEXT, type Proposal } from "@pulse/shared";
import { sanitiseError } from "../../../notify.js";
import { parseToolResult } from "../../garmin/client.js";
import { isBeingConfirmed } from "../confirmations.js";

/**
 * The Garmin executor. This is the only file in the API source that names a Garmin write tool (D32),
 * and the only file that may call one. It is imported only by the confirm route.
 * Phase 3 allows two tools: moving a scheduled workout to another date and removing it from the calendar.
 * Scheduling a new workout is not built.
 */
export const GARMIN_WRITE_TOOLS = ["reschedule_workout", "unschedule_workout"] as const;
export type GarminWriteTool = (typeof GARMIN_WRITE_TOOLS)[number];

export function assertWriteTool(name: string): asserts name is GarminWriteTool {
  if (!(GARMIN_WRITE_TOOLS as readonly string[]).includes(name)) throw new Error(`Refusing to call ${name}: not on the write allowlist`);
}

export interface GarminWriter {
  call(tool: GarminWriteTool, args: Record<string, unknown>): Promise<{ text: string }>;
  close(): Promise<void>;
}
export type GarminWriterFactory = () => Promise<GarminWriter>;

/** A write session with the Garmin MCP server. Created only when a live write is about to happen. */
export function createMcpWriterFactory(url: string): GarminWriterFactory {
  return async () => {
    const client = new Client({ name: `${APP_NAME} (pulse writes)`, version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return {
      async call(tool, args) {
        assertWriteTool(tool);
        const result = await client.callTool({ name: tool, arguments: args });
        const parsed = parseToolResult({ isError: "isError" in result ? result.isError === true : false, content: "content" in result ? result.content : [] });
        if (parsed.kind === "message") {
          if (/error|fail|could not|unable|not found|invalid/i.test(parsed.text)) throw new Error(parsed.text);
          return { text: parsed.text };
        }
        const data = parsed.data;
        if (typeof data === "object" && data !== null && "error" in data && data.error) throw new Error(String(data.error));
        return { text: "ok" };
      },
      close: () => client.close(),
    };
  };
}

export interface ExecutionResult {
  mode: "live" | "dry_run";
  message: string;
}

export interface ExecutorDeps {
  writesEnabled: boolean;
  getWriter: GarminWriterFactory;
}

/** Runs one confirmed proposal. With writes off it records a dry run and does not touch Garmin at all, not even a connection. */
export async function executeGarminProposal(p: Proposal, deps: ExecutorDeps): Promise<ExecutionResult> {
  if (!isBeingConfirmed(p.id)) throw new Error("Refusing to run: this proposal is not being confirmed.");
  if (p.status !== "pending") throw new Error("Refusing to run: the proposal is not pending.");
  if (!deps.writesEnabled) return { mode: "dry_run", message: `${DRY_RUN_TEXT}. The change was recorded only.` };

  const writer = await deps.getWriter();
  try {
    if (p.kind === "garmin.reschedule") {
      if (!p.after) throw new Error("A reschedule needs a new date.");
      const res = await writer.call("reschedule_workout", { scheduled_workout_id: Number(p.before.scheduledId), calendar_date: p.after.date });
      return { mode: "live", message: sanitiseError(res.text) };
    }
    const res = await writer.call("unschedule_workout", { scheduled_workout_id: Number(p.before.scheduledId) });
    return { mode: "live", message: sanitiseError(res.text) };
  } finally {
    await writer.close().catch(() => undefined);
  }
}
