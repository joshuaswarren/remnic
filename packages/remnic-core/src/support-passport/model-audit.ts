import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { expandTildePath } from "../utils/path.js";
import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";
import {
  appendPrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  ensurePrivateDirectoryTreeNoFollow,
  withPrivateDirectoryNoFollow,
} from "./private-file.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const SupportPassportModelAuditRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.enum(["draft_cards", "answer_question"]),
    actorHash: HashSchema,
    subjectIdsHash: HashSchema,
    modelUsed: z.string().trim().min(1).max(256),
    route: z.enum(["local", "direct", "gateway", "unavailable"]),
    outputSchemaVersion: z.literal(1),
    outcome: z.enum(["success", "error"]),
    errorClass: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/)
      .optional(),
    occurredAt: z.string().datetime({ offset: true }),
    latencyMs: z.number().int().nonnegative(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.outcome === "error" && !record.errorClass) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error records require an error class",
        path: ["errorClass"],
      });
    }
    if (record.outcome === "success" && record.errorClass) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "success records cannot have an error class",
        path: ["errorClass"],
      });
    }
  });

export type SupportPassportModelAuditRecord = z.infer<typeof SupportPassportModelAuditRecordSchema>;

export interface SupportPassportModelAuditSink {
  record(record: SupportPassportModelAuditRecord): Promise<void>;
}

export function hashSupportPassportAuditValues(domain: string, values: string[]): string {
  return createHash("sha256")
    .update(`support-passport-audit:${domain}:v1`)
    .update("\0")
    .update([...values].sort().join("\0"))
    .digest("hex");
}

export class SupportPassportModelAuditStore implements SupportPassportModelAuditSink {
  private readonly memoryDir: string;
  private readonly auditDir: string;
  private readonly runWithHeldFileLock: typeof withHeldFileLock;

  constructor(options: { memoryDir: string; withHeldFileLock?: typeof withHeldFileLock }) {
    this.memoryDir = path.resolve(expandTildePath(options.memoryDir));
    this.auditDir = path.join(this.memoryDir, "state", "support-passport", "audit");
    this.runWithHeldFileLock = options.withHeldFileLock ?? withHeldFileLock;
  }

  async record(input: SupportPassportModelAuditRecord): Promise<void> {
    const record = SupportPassportModelAuditRecordSchema.parse(input);
    await this.ensureSafeDirectories();
    const day = record.occurredAt.slice(0, 10);
    const filePath = path.join(this.auditDir, `${day}.jsonl`);
    await serializeMutations(`support-passport-audit:${filePath}`, () =>
      withPrivateDirectoryNoFollow(
        this.memoryDir,
        this.auditDir,
        "support passport audit directory must remain inside the memory directory",
        async (pinnedDirectory) =>
          await this.runWithHeldFileLock(
            path.join(pinnedDirectory, `.${day}.lock`),
            {
              staleMs: 30_000,
              maxWaitMs: 5_000,
              heartbeatMs: 10_000,
            },
            async (acquired) => {
              if (!acquired) throw new Error("could not acquire the support passport audit lock");
              await appendPrivateFileNoFollow(
                this.auditDir,
                filePath,
                `${JSON.stringify(record)}\n`,
                "support passport audit paths must be regular files in a stable directory",
                this.memoryDir
              );
            }
          )
      )
    );
  }

  private async ensureSafeDirectories(): Promise<void> {
    await ensurePrivateDirectoryTreeNoFollow(
      this.memoryDir,
      "support passport memory directory must be a stable directory"
    );
    await ensurePrivateDirectoryNoFollow(
      this.memoryDir,
      this.auditDir,
      "support passport audit directory must remain inside the memory directory"
    );
  }
}
