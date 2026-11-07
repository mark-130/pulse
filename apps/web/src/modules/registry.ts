import type { ComponentType } from "react";
import type { WidgetDef } from "@pulse/shared";

export interface WebWidget extends WidgetDef {
  component: ComponentType;
}

/** Module widgets register a card into the Today grid. Empty in Phase 0. */
export const widgets: WebWidget[] = [];
