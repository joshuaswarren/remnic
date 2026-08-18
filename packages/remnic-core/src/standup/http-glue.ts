import type { ServerResponse } from "node:http";
import { getOperation } from "../access-boundary.js";
import type { EngramAccessService } from "../access-service.js";

export async function respondStandup(
  date: string | null,
  res: ServerResponse,
  respondJson: (res: ServerResponse, status: number, payload: unknown) => void,
  service: EngramAccessService,
): Promise<void> {
  const op = getOperation("standup");
  if (!op) throw new Error("access-boundary: operation not registered: standup");
  const output = (await op.run({ ...(date ? { date } : {}) }, { service })) as { result: unknown };
  respondJson(res, 200, output.result);
}
