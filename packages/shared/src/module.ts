import { z } from "zod";

export const widgetSizeSchema = z.enum(["1x1", "2x1"]);
export type WidgetSize = z.infer<typeof widgetSizeSchema>;

export interface WidgetDef {
  id: string;
  title: string;
  size: WidgetSize;
}

export interface JobDef {
  name: string;
  /** Cron expression, evaluated in Europe/London. */
  schedule: string;
  run: () => Promise<void>;
}

export interface AiToolDef {
  name: string;
  description: string;
  /** Write-shaped tools may only insert a proposal. See docs/AI.md. */
  kind: "read" | "propose";
}

/**
 * A feature module. R is the router type of the host (Hono on the API side),
 * kept generic so this package has no server dependency.
 */
export interface Module<R = unknown> {
  name: string;
  routes?: (router: R) => void;
  jobs?: JobDef[];
  aiTools?: AiToolDef[];
  widgets?: WidgetDef[];
}
