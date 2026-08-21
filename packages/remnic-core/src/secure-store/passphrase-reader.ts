/**
 * TTY passphrase reader (issue #690 PR 2/4).
 *
 * Reads a line from stdin without echoing it back to the terminal.
 * Disables echo by setting raw mode + manually buffering input until
 * Enter / EOT.
 *
 * Why not `readline.question`?
 * ----------------------------
 * `readline` echoes by default and has no clean "no-echo" toggle that
 * survives across Node versions. The raw-mode loop is the canonical
 * idiom for reading passwords on Node and matches what `npm` uses
 * internally.
 *
 * Security
 * --------
 *   - Never log the passphrase (no `console.log`, no debug output).
 *   - Never include it in a thrown error message.
 *   - On Ctrl+C / Ctrl+D, abort with a clear error rather than
 *     silently treating EOF as an empty submission.
 *   - On non-TTY stdin (pipe, redirect), read a line via line-buffered
 *     readline so automation (`echo "passphrase" | remnic ...`) works.
 *     Operators are responsible for not piping plaintext passphrases
 *     in shell history; we surface a stderr warning.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import type { PassphraseReader } from "./cli-handlers.js";

export interface CreatePassphraseReaderOptions {
  input?: Readable;
  output?: Writable;
  /** Override stderr for warning surface; defaults to `process.stderr`. */
  errorStream?: Writable;
}

/**
 * Build a `PassphraseReader` bound to the given streams. Exported so
 * tests can construct one against in-memory streams without touching
 * the real TTY.
 */
export function createPassphraseReader(
  options: CreatePassphraseReaderOptions = {},
): PassphraseReader {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorStream = options.errorStream ?? process.stderr;
  // Codex/Cursor on PR #737: a fresh readline interface per call
  // breaks confirm-mode on piped non-TTY input — the first
  // `createInterface` consumes the entire prebuffered stream
  // (including the second line), so the second `createInterface`
  // sees an already-ended stream and resolves to "". Fix: maintain
  // ONE non-TTY line reader across both reads of a confirm-mode
  // session and pull lines on demand from a buffered queue.
  let nonTtyReader: NonTtyLineReader | null = null;
  let nonTtyWarned = false;
  return async function readPassphrase(
    prompt: string,
    readerOptions?: { confirm?: boolean },
  ): Promise<string> {
    const first = await readSinglePassphrase(prompt);
    if (readerOptions?.confirm) {
      const second = await readSinglePassphrase("Confirm passphrase: ");
      if (first !== second) {
        throw new Error("passphrases did not match");
      }
    }
    return first;
  };

  async function readSinglePassphrase(prompt: string): Promise<string> {
    const inputAsAny = input as Readable & {
      isTTY?: boolean;
      setRawMode?: (raw: boolean) => Readable;
    };
    if (inputAsAny.isTTY && typeof inputAsAny.setRawMode === "function") {
      return readNoEcho(prompt, inputAsAny, output);
    }
    // Non-TTY: line-buffered fallback. Warn once per reader so
    // operators piping plaintext passphrases in shell pipelines are
    // aware their history may contain the secret.
    if (!nonTtyWarned) {
      errorStream.write(
        "[remnic secure-store] warning: stdin is not a TTY; reading passphrase as a plain line. " +
          "Take care that the passphrase is not exposed in shell history.\n",
      );
      nonTtyWarned = true;
    }
    // Codex P1 on PR #737: write the prompt to stderr, not stdout.
    // When the surrounding command outputs JSON to stdout (e.g.
    // `remnic secure-store status --json`), injecting prompt text on
    // stdout corrupts the JSON output and breaks machine consumers.
    // The prompt is UI noise — it belongs on the error/diagnostics
    // stream regardless of whether we're in a TTY.
    errorStream.write(prompt);
    if (!nonTtyReader) nonTtyReader = createNonTtyLineReader(input);
    return nonTtyReader.next();
  }
}

function readNoEcho(
  prompt: string,
  input: Readable & { setRawMode?: (raw: boolean) => Readable },
  output: Writable,
): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let buffer = "";
    let settled = false;
    const wasRaw = (input as Readable & { isRaw?: boolean }).isRaw === true;
    // Codex P2 on PR #737: per-chunk `chunk.toString("utf8")` corrupts
    // multibyte characters that straddle a chunk boundary (Node inserts
    // U+FFFD replacement characters for incomplete sequences). Use a
    // StringDecoder, which buffers partial sequences across chunks so
    // non-ASCII passphrases survive intact.
    const decoder = new StringDecoder("utf8");
    if (input.setRawMode) input.setRawMode(true);
    input.resume();
    const cleanup = (): void => {
      input.pause();
      input.removeListener("data", onData);
      // Flush any remaining bytes the decoder is holding so trailing
      // partial sequences are surfaced rather than silently swallowed.
      decoder.end();
      // Restore the prior raw-mode state so we don't strand the parent shell
      // in an unexpected configuration.
      if (input.setRawMode) input.setRawMode(wasRaw);
      output.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      const str = decoder.write(chunk);
      for (const ch of str) {
        if (settled) return;
        const code = ch.charCodeAt(0);
        // Enter / newline: submit.
        if (ch === "\n" || ch === "\r") {
          settled = true;
          cleanup();
          resolve(buffer);
          return;
        }
        // Ctrl+C: abort.
        if (code === 0x03) {
          settled = true;
          cleanup();
          reject(new Error("passphrase entry aborted (Ctrl+C)"));
          return;
        }
        // Ctrl+D / EOT: treat as abort if buffer is empty, else submit.
        if (code === 0x04) {
          settled = true;
          cleanup();
          if (buffer.length === 0) {
            reject(new Error("passphrase entry aborted (EOF)"));
          } else {
            resolve(buffer);
          }
          return;
        }
        // Backspace / DEL.
        // Cursor on PR #737: `buffer.slice(0, -1)` deletes one UTF-16
        // code unit, which splits a surrogate pair when the last
        // character is a non-BMP code point (emoji, etc.). Fix: count
        // code points with `Array.from` and remove the last one. This
        // correctly handles both BMP (single code unit) and non-BMP
        // (surrogate pair) characters atomically.
        if (code === 0x08 || code === 0x7f) {
          if (buffer.length > 0) {
            const codePoints = Array.from(buffer);
            buffer = codePoints.slice(0, -1).join("");
          }
          continue;
        }
        // Ignore other control bytes (escape sequences, etc.).
        if (code < 0x20) {
          continue;
        }
        buffer += ch;
      }
    };
    input.on("data", onData);
  });
}

/**
 * One-shot line reader bound to a non-TTY input stream.
 *
 * Cursor medium on PR #737: a previous version constructed a fresh
 * `readline.createInterface` per `next()` call. On piped non-TTY
 * input, the first interface consumed the entire prebuffered stream
 * (including any subsequent lines) into its internal buffer. The
 * second interface saw an already-`end()`'d input and resolved to "".
 * Fix: construct ONE readline interface, queue every emitted `line`,
 * and let `next()` either return a queued line or wait for the next
 * one. Pending waiters at `close` time are resolved with "" (so an
 * abandoned-stream caller still sees a clean empty response).
 */
interface NonTtyLineReader {
  next(): Promise<string>;
}

function createNonTtyLineReader(input: Readable): NonTtyLineReader {
  const rl = createInterface({ input, terminal: false });
  const lineQueue: string[] = [];
  const waiterQueue: Array<(value: string) => void> = [];
  const errorQueue: Array<(err: Error) => void> = [];
  let closed = false;
  let error: Error | null = null;

  rl.on("line", (line: string) => {
    const waiter = waiterQueue.shift();
    if (waiter) {
      waiter(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    while (waiterQueue.length > 0) {
      const w = waiterQueue.shift()!;
      // Drop the matching error slot since we're settling cleanly.
      errorQueue.shift();
      w("");
    }
  });
  rl.on("error", (err: Error) => {
    error = err;
    while (errorQueue.length > 0) {
      const r = errorQueue.shift()!;
      // Drop the matching value slot.
      waiterQueue.shift();
      r(err);
    }
  });

  return {
    next(): Promise<string> {
      if (error) return Promise.reject(error);
      const queued = lineQueue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (closed) return Promise.resolve("");
      return new Promise<string>((resolve, reject) => {
        waiterQueue.push(resolve);
        errorQueue.push(reject);
      });
    },
  };
}
