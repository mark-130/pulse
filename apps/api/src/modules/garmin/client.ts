import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { APP_NAME } from "@pulse/shared";

/**
 * The only Garmin tools NGtive Split may call. Phase 1 is read only. This is an allowlist,
 * so any tool not named here, including every write tool, is refused before a request is made.
 */
export const GARMIN_READ_TOOLS = [
  "get_scheduled_workouts",
  "get_workout_by_id",
  "get_training_readiness",
  "get_morning_training_readiness",
  "get_sleep_summary",
  // History import (4c, D51): range and trend tools that cut the call count. Both are get_ tools and read only.
  "get_sleep_summary_range",
  "get_hrv_trend",
  "get_hrv_data",
  "get_rhr_day",
  "get_body_battery",
  "get_stats",
  "get_training_status",
  "get_training_load_balance",
  "get_training_load_trend",
  "get_vo2max_trend",
  "get_heart_rate_zones",
  "get_personal_record",
  "get_hill_score",
  "get_lactate_threshold",
  "get_running_tolerance_trend",
  "get_endurance_score",
  "get_race_predictions",
  "get_activities_by_date",
  "get_activity",
  "get_activity_hr_in_timezones",
  "get_calendar_events",
] as const;

export type GarminReadTool = (typeof GARMIN_READ_TOOLS)[number];

export type GarminResult = { kind: "json"; data: unknown } | { kind: "message"; text: string };

/** A session with the Garmin MCP server. Tests supply a fake. */
export interface GarminSession {
  call(tool: GarminReadTool, args: Record<string, unknown>): Promise<GarminResult>;
  close(): Promise<void>;
}

export type GarminConnector = () => Promise<GarminSession>;

export function isReadTool(name: string): name is GarminReadTool {
  return (GARMIN_READ_TOOLS as readonly string[]).includes(name);
}

export function assertReadTool(name: string): asserts name is GarminReadTool {
  if (!isReadTool(name)) throw new Error(`Refusing to call ${name}: not on the read-only allowlist`);
}

/** Turns an MCP tool result into JSON, or a plain message such as "No data found". */
export function parseToolResult(result: { isError?: boolean; content?: unknown }): GarminResult {
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((p: unknown) => (typeof p === "object" && p !== null && "text" in p && typeof p.text === "string" ? p.text : ""))
    .join("");
  if (result.isError) throw new Error(`Garmin tool error: ${text.slice(0, 120)}`);
  try {
    return { kind: "json", data: JSON.parse(text) };
  } catch {
    return { kind: "message", text };
  }
}

export function createMcpConnector(url: string): GarminConnector {
  return async () => {
    const client = new Client({ name: `${APP_NAME} (pulse)`, version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return {
      async call(tool, args) {
        assertReadTool(tool);
        const result = await client.callTool({ name: tool, arguments: args });
        return parseToolResult({ isError: "isError" in result ? result.isError === true : false, content: "content" in result ? result.content : [] });
      },
      close: () => client.close(),
    };
  };
}
