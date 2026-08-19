/**
 * Shared-context trajectory publish (issue #1957).
 *
 * First slice: mode gate + sanitization only. Persistence and
 * findTrajectories come later.
 */

export const TRAJECTORY_SHARE_MODES = ["off", "review", "auto"] as const;
export type TrajectoryShareMode = (typeof TRAJECTORY_SHARE_MODES)[number];

export interface PublishTrajectoryInput {
  mode?: string;
  trajectoryId: string;
  summary: string;
}

export type PublishTrajectoryResult =
  | { ok: false; error: "disabled" | "unknown_mode" }
  | {
      ok: true;
      status: "pending_review" | "active";
      trajectoryId: string;
      summary: string;
    };

const MODE_STATUS = {
  review: "pending_review",
  auto: "active",
} as const;

function isTrajectoryShareMode(value: string): value is TrajectoryShareMode {
  return (TRAJECTORY_SHARE_MODES as readonly string[]).includes(value);
}

export function publishTrajectory(input: PublishTrajectoryInput): PublishTrajectoryResult {
  const mode = input.mode ?? "review";
  if (!isTrajectoryShareMode(mode)) {
    return { ok: false, error: "unknown_mode" };
  }
  if (mode === "off") {
    return { ok: false, error: "disabled" };
  }
  return {
    ok: true,
    status: MODE_STATUS[mode],
    trajectoryId: input.trajectoryId,
    summary: input.summary,
  };
}
