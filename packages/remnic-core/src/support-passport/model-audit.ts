import { createHash } from "node:crypto";
import { appendFile, chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { serializeMutations, withHeldFileLock } from "../utils/serialize-mutations.js";

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

  constructor(options: { memoryDir: string }) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.auditDir = path.join(this.memoryDir, "state", "support-passport", "audit");
  }

  async record(input: SupportPassportModelAuditRecord): Promise<void> {
    const record = SupportPassportModelAuditRecordSchema.parse(input);
    await this.ensureSafeDirectories();
    const day = record.occurredAt.slice(0, 10);
    const filePath = path.join(this.auditDir, `${day}.jsonl`);
    const lockPath = path.join(this.auditDir, `.${day}.lock`);
    await serializeMutations(`support-passport-audit:${filePath}`, () =>
      withHeldFileLock(
        lockPath,
        {
          staleMs: 30_000,
          maxWaitMs: 5_000,
          heartbeatMs: 10_000,
        },
        async (acquired) => {
          if (!acquired) throw new Error("could not acquire the support passport audit lock");
          try {
            const metadata = await lstat(filePath);
            if (metadata.isSymbolicLink() || !metadata.isFile()) {
              throw new Error("support passport audit paths must be regular files");
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await appendFile(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
          await chmod(filePath, 0o600);
        }
      )
    );
  }

  private async ensureSafeDirectories(): Promise<void> {
    const directories = [
      this.memoryDir,
      path.join(this.memoryDir, "state"),
      path.join(this.memoryDir, "state", "support-passport"),
      this.auditDir,
    ];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const metadata = await lstat(directory);
      if (metadata.isSymbolicLink()) throw new Error("support passport audit directories must not be symbolic links");
      if (!metadata.isDirectory()) throw new Error("support passport audit paths must be directories");
    }
    await Promise.all(directories.slice(1).map((directory) => chmod(directory, 0o700)));
  }
}
