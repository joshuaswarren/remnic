import type { BenchIntegritySummary } from "../bench-data";
import { describeIntegrity } from "./integrity-model";

export { describeIntegrity } from "./integrity-model";
export type {
  IntegrityBadgeLevel,
  IntegrityBadgeModel,
} from "./integrity-model";

export function IntegrityBadge({ summary }: { summary: BenchIntegritySummary }) {
  const model = describeIntegrity(summary);
  const tooltipParts = [
    model.splitText,
    model.canaryText,
    ...model.sealLines,
    ...model.reasons,
  ];

  return (
    <span
      className={`integrity-badge integrity-badge--${model.level}`}
      title={tooltipParts.join("\n")}
      data-level={model.level}
    >
      <span className="integrity-badge__dot" aria-hidden="true" />
      <span className="integrity-badge__label">{model.label}</span>
    </span>
  );
}
import * as React from "react";
