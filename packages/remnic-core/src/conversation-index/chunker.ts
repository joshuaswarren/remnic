import type { TranscriptEntry } from "../types.js";

export interface ConversationChunk {
  id: string;
  sessionKey: string;
  startTs: string;
  endTs: string;
  text: string;
}

export function chunkTranscriptEntries(
  sessionKey: string,
  entries: TranscriptEntry[],
  opts: { maxChars: number; maxTurns: number },
): ConversationChunk[] {
  const maxChars = Math.max(500, opts.maxChars);
  const maxTurns = Math.max(5, opts.maxTurns);
  const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const out: ConversationChunk[] = [];
  let buf: TranscriptEntry[] = [];
  let bufChars = 0;

  function flush(): void {
    if (buf.length === 0) return;
    const startTs = buf[0]!.timestamp;
    const endTs = buf[buf.length - 1]!.timestamp;
    const text = buf.map((e) => `[${e.role}] ${e.content}`).join("\n\n");
    const id = `${startTs}-${out.length}`.replace(/[:.]/g, "-");
    out.push({ id, sessionKey, startTs, endTs, text });
    buf = [];
    bufChars = 0;
  }

  for (const e of sorted) {
    const line = `[${e.role}] ${e.content}\n\n`;
    if (buf.length >= maxTurns || bufChars + line.length > maxChars) {
      flush();
    }
    buf.push(e);
    bufChars += line.length;
  }
  flush();

  return out;
}

