/**
 * Multi-provider CLI agent invoker for swamp.
 *
 * Runs coding-agent CLI tools (claude, opencode, amp, gemini, codex) with typed
 * inputs, captures structured outputs including token counts, cost, duration,
 * exit code, and automatic retries on transient failures. Supports slash
 * command resolution from a configurable commands directory and optional JSON
 * response parsing.
 *
 * @module
 */

import { z } from "npm:zod@4";

// Schemas below are written without explicit z.Zod* type annotations: zod 4's
// inferred types are the source of truth, and pinning them by hand (e.g.
// `z.ZodEnum<["claude", ...]>`) both drifts from zod 4's actual generic shapes
// (which fails `deno check`) and forces a same-edit update on every change.

/** Supported CLI agent providers. */
const ProviderEnum = z.enum([
  "claude",
  "opencode",
  "amp",
  "gemini",
  "codex",
]);

/** Global configuration arguments shared across all method invocations. */
const GlobalArgsSchema = z.object({
  defaultProvider: ProviderEnum.default("claude"),
  defaultModel: z.string().default("opus"),
  commandsDir: z.string().default(".claude/commands"),
  commandSubdirs: z.array(z.string()).default([]).describe(
    "Additional subdirectories under commandsDir to search for slash commands",
  ),
  claudePath: z.string().default("claude"),
  opencodePath: z.string().default("opencode"),
  ampPath: z.string().default("amp"),
  geminiPath: z.string().default("gemini"),
  codexPath: z.string().default("codex"),
  idleTimeoutMs: z.number().default(600_000),
  wallTimeoutMs: z.number().default(3_600_000),
  maxRetries: z.number().default(2),
});

/** Schema for a structured invocation record persisted as a swamp resource. */
const InvocationSchema = z.object({
  invocationId: z.string(),
  provider: ProviderEnum,
  model: z.string(),
  prompt: z.string(),
  promptHash: z.string(),
  slashCommand: z.string().optional(),
  cwd: z.string(),
  exitCode: z.number(),
  success: z.boolean(),
  durationMs: z.number(),
  outputBytes: z.number(),
  outputPreview: z.string(),
  outputTokensPerSecond: z.number().optional(),
  retries: z.number(),
  timedOut: z.boolean(),
  timeoutReason: z.string().optional(),
  failureReason: z.string().optional().describe(
    "Why the invocation failed: provider_error:<code>, exit_<n>, or a timeout reason. Absent on success.",
  ),
  invokedAt: z.string(),
  tokens: z.object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    total: z.number().optional(),
    reasoning: z.number().optional(),
  }).optional(),
  costUsd: z.number().optional(),
  tags: z.record(z.string(), z.string()).optional(),
}).passthrough();

/**
 * Schema for the untruncated companion record to an invocation: the full
 * original prompt and the full extracted output, neither subject to the
 * preview caps on the invocation record itself.
 */
const TranscriptSchema = z.object({
  invocationId: z.string(),
  prompt: z.string(),
  output: z.string(),
}).passthrough();

/** Schema for the result of enumerating a provider's available models. */
const ModelListSchema = z.object({
  provider: ProviderEnum,
  models: z.array(z.string()),
  count: z.number(),
  listedAt: z.string(),
}).passthrough();

/** Exit codes that indicate a transient failure eligible for retry. */
const TRANSIENT_EXIT_CODES: Set<number> = new Set([137, 143]);

/** Compute a simple numeric hash of a prompt string, returned as base-36. */
function hashPrompt(prompt: string): string {
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    const char = prompt.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Generate a v4 UUID. */
function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Resolve a slash command (e.g. "/review fix the bug") into a full prompt
 * by reading the corresponding markdown file from the commands directory.
 */
async function resolveSlashCommand(
  prompt: string,
  commandsDir: string,
  commandSubdirs: string[],
  cwd: string,
): Promise<{ resolved: string; slashCommand?: string }> {
  if (!prompt.startsWith("/")) return { resolved: prompt };

  const parts = prompt.split(" ", 2);
  const commandName = parts[0].slice(1);
  const args = parts[1] || "";

  const candidates: string[] = [
    `${commandsDir}/${commandName}.md`,
    `${commandsDir}/${commandName.replace(/-/g, "/")}.md`,
    ...commandSubdirs.map((sub) => `${commandsDir}/${sub}/${commandName}.md`),
  ];

  for (const candidate of candidates) {
    const fullPath = candidate.startsWith("/")
      ? candidate
      : `${cwd}/${candidate}`;
    try {
      let content = await Deno.readTextFile(fullPath);
      if (content.startsWith("---")) {
        const match = content.match(/^---\n[\s\S]*?\n---\n/);
        if (match) content = content.slice(match[0].length);
      }
      if (args && content.includes("$ARGUMENTS")) {
        return {
          resolved: content.replaceAll("$ARGUMENTS", args),
          slashCommand: commandName,
        };
      }
      return {
        resolved: args ? `${content}\n\n${args}` : content,
        slashCommand: commandName,
      };
    } catch { /* file not found, try next */ }
  }

  return { resolved: prompt, slashCommand: commandName };
}

/** Structured result from running a CLI subprocess. */
type CmdResult = {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
  timedOut: boolean;
  timeoutReason?: string;
  durationMs: number;
};

/** How long to wait for a SIGTERM'd child to exit before escalating to SIGKILL. */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Spawn a CLI subprocess with optional stdin and two independent timeouts:
 *
 * - **wall timeout** — a hard ceiling on total runtime.
 * - **idle timeout** — kills the process if it produces NO new stdout/stderr
 *   bytes for `idleTimeoutMs`. This is the defense against a provider that
 *   silently stalls (e.g. an agent CLI stuck retrying a rate-limited request):
 *   it never trips the wall clock for an hour, but it also never makes
 *   progress, so the idle timer catches it in minutes instead.
 *
 * Output streams are drained incrementally so the timers observe real progress
 * — `child.output()` would block until exit and defeat idle detection. On
 * timeout the child is SIGTERM'd, then SIGKILL'd if it ignores SIGTERM, so a
 * wedged process can never hold the caller (and the swamp model lock) open
 * indefinitely.
 */
async function runCli(
  cmd: string[],
  opts: {
    cwd?: string;
    stdin?: string;
    wallTimeoutMs: number;
    idleTimeoutMs?: number;
  },
): Promise<CmdResult> {
  const start = performance.now();
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    stdin: opts.stdin ? "piped" : "null",
    cwd: opts.cwd,
  });

  const child = command.spawn();
  if (opts.stdin && child.stdin) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }

  let lastOutputAt = performance.now();
  let timeoutReason: string | undefined;
  let killed = false;

  // Cancel the output streams so the drain loops below terminate even when a
  // SURVIVING GRANDCHILD still holds the pipe's write end open. Killing the
  // direct child does NOT close pipes inherited by its descendants, so without
  // this `for await … of child.stdout` would block forever and the caller (and
  // the swamp model lock) would hang despite the kill — the exact wedge this
  // function exists to prevent.
  const cancelStreams = () => {
    child.stdout.cancel().catch(() => {});
    child.stderr.cancel().catch(() => {});
  };

  // Escalating kill: SIGTERM, then SIGKILL if the child doesn't exit promptly,
  // then cancel the streams to unblock the drains regardless of grandchildren.
  const killChild = async (reason: string) => {
    if (killed) return;
    killed = true;
    timeoutReason = reason;
    try {
      child.kill("SIGTERM");
    } catch { /* already dead */ }
    await new Promise((r) => setTimeout(r, SIGKILL_GRACE_MS));
    try {
      child.kill("SIGKILL");
    } catch { /* already dead */ }
    cancelStreams();
  };

  // Drain a stream into a buffer, stamping lastOutputAt on every chunk so the
  // idle watchdog sees progress. A cancelled stream throws here; swallow it.
  const chunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    sink: Uint8Array[],
  ) => {
    try {
      for await (const chunk of stream) {
        lastOutputAt = performance.now();
        sink.push(chunk);
      }
    } catch { /* stream cancelled on kill */ }
  };
  const drains = Promise.all([
    drain(child.stdout, chunks),
    drain(child.stderr, errChunks),
  ]);

  // Watchdog: poll for wall/idle timeouts on a 1s tick. `done` stops the loop
  // the moment the child exits so we don't leave a dangling timer keeping the
  // isolate alive.
  let done = false;
  const watch = (async () => {
    const idleMs = opts.idleTimeoutMs;
    while (!done) {
      await new Promise((r) => setTimeout(r, 1_000));
      if (done) return;
      const now = performance.now();
      if (now - start >= opts.wallTimeoutMs) {
        await killChild("wall_time_exceeded");
        return;
      }
      if (idleMs && idleMs > 0 && now - lastOutputAt >= idleMs) {
        await killChild("idle_time_exceeded");
        return;
      }
    }
  })();

  // child.status resolves when the DIRECT child exits, even if grandchildren
  // survive. On a normal exit the pipes close and the drains EOF on their own;
  // on a kill, cancelStreams() (in killChild) forces them to finish. As a final
  // backstop, cancel the streams if the drains haven't settled shortly after
  // the child exits — so a wedged drain can never outlive the process.
  const status = await child.status;
  done = true;
  await Promise.race([
    drains,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        cancelStreams();
        resolve();
      }, 2_000)
    ),
  ]);
  await watch;

  const durationMs = Math.round(performance.now() - start);

  return {
    stdout: new TextDecoder().decode(concatChunks(chunks)),
    stderr: new TextDecoder().decode(concatChunks(errChunks)),
    code: status.code,
    success: status.success && !killed,
    timedOut: killed,
    timeoutReason,
    durationMs,
  };
}

/** Concatenate an array of byte chunks into a single Uint8Array. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Build the command array for the Claude CLI. */
function buildClaudeCommand(
  cliPath: string,
  model: string,
  resolvedPrompt: string,
): { cmd: string[]; stdin?: string } {
  const cmd = [
    cliPath,
    "--model",
    model,
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ];
  cmd.push(resolvedPrompt);
  return { cmd };
}

/** Build the command array for the OpenCode CLI. */
function buildOpencodeCommand(
  cliPath: string,
  model: string,
  resolvedPrompt: string,
): { cmd: string[]; stdin?: string } {
  return {
    cmd: [cliPath, "run", "--format", "json", "--model", model, resolvedPrompt],
  };
}

/**
 * Build the command array for the Amp CLI.
 *
 * `--stream-json` makes amp emit Claude-Code-compatible stream JSON (one event
 * per line) instead of plain text, so token usage can be parsed from the
 * `assistant` events. The prompt is fed on stdin in execute mode (`-x`).
 */
function buildAmpCommand(
  cliPath: string,
  _model: string,
  resolvedPrompt: string,
): { cmd: string[]; stdin?: string } {
  return {
    cmd: [cliPath, "--dangerously-allow-all", "-x", "--stream-json"],
    stdin: resolvedPrompt,
  };
}

/** Build the command array for the Gemini CLI. */
function buildGeminiCommand(
  cliPath: string,
  model: string,
  resolvedPrompt: string,
): { cmd: string[]; stdin?: string } {
  return {
    cmd: [cliPath, "-p", resolvedPrompt, "-m", model, "--yolo", "-o", "json"],
  };
}

/**
 * Build the command array for the OpenAI Codex CLI.
 *
 * `codex exec --json` runs non-interactively and emits one JSON event per line
 * (JSONL). The prompt is the final positional argument — codex reads from stdin
 * only when no prompt arg is given, so we must NOT pipe it on stdin. `--color
 * never` keeps ANSI codes out of the captured stream.
 */
function buildCodexCommand(
  cliPath: string,
  model: string,
  resolvedPrompt: string,
): { cmd: string[]; stdin?: string } {
  return {
    cmd: [
      cliPath,
      "exec",
      "--json",
      "--color",
      "never",
      "-m",
      model,
      resolvedPrompt,
    ],
  };
}

/**
 * Extract human-readable text from a provider's raw CLI output, handling
 * provider-specific JSON streaming formats.
 */
export function extractTextFromOutput(
  provider: string,
  rawOutput: string,
): string {
  if (provider === "claude") {
    for (const line of rawOutput.split("\n").reverse()) {
      try {
        const event = JSON.parse(line);
        if (event.type === "result") return event.result || rawOutput;
      } catch { /* not JSON */ }
    }
    return rawOutput;
  }
  if (provider === "opencode") {
    const parts: string[] = [];
    for (const line of rawOutput.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type === "text") {
          const text = event.part?.text || event.part?.content;
          if (text) parts.push(text);
        }
      } catch { /* skip */ }
    }
    if (parts.length > 0) return parts.join("");
    // No assistant text — surface the structured error message if there is one
    // (e.g. a quota/rate-limit `type:"error"` event) rather than the raw JSON.
    const err = extractError(provider, rawOutput);
    return err ? err.message : rawOutput;
  }
  if (provider === "amp") {
    // Amp's stream JSON mirrors Claude's: the terminal `result` event carries
    // the final assistant text in a `result` field.
    for (const line of rawOutput.split("\n").reverse()) {
      try {
        const event = JSON.parse(line);
        if (event.type === "result") return event.result || rawOutput;
      } catch { /* not JSON */ }
    }
    return rawOutput;
  }
  if (provider === "gemini") {
    try {
      const data = JSON.parse(rawOutput);
      return data.response || rawOutput;
    } catch {
      return rawOutput;
    }
  }
  if (provider === "codex") {
    // codex exec --json emits JSONL; the answer is the LAST item.completed
    // event whose item is an `agent_message`. Forward-scan and keep the last.
    let text: string | undefined;
    for (const line of rawOutput.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          typeof event.item?.text === "string"
        ) {
          text = event.item.text;
        }
      } catch { /* not JSON */ }
    }
    if (text !== undefined) return text;
    // No agent message — surface the error message if codex reported one
    // (e.g. a bad model id), rather than the raw JSONL blob. Mirrors opencode.
    const err = extractError(provider, rawOutput);
    return err ? err.message : rawOutput;
  }
  return rawOutput;
}

/** A provider-reported API/agent error surfaced in the CLI's output stream. */
export interface ProviderError {
  /** Human-readable message (e.g. "Payment Required: You have exceeded your monthly quota"). */
  message: string;
  /** Provider/HTTP error code when available (e.g. "quota_exceeded", 402, "rate_limit"). */
  code?: string;
  /** True when the provider marks the error as retryable (rate limits, 429, 5xx). */
  retryable: boolean;
}

/** Substrings (lowercased) in an error message that signal a rate-limit / quota condition. */
const RATE_LIMIT_HINTS: string[] = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "quota",
  "too many requests",
  "overloaded",
  "payment required",
  "insufficient_quota",
  "429",
];

/** True when an error message/code looks like a rate-limit or quota exhaustion. */
function looksRateLimited(message: string, code?: string | number): boolean {
  const hay = `${message} ${code ?? ""}`.toLowerCase();
  return RATE_LIMIT_HINTS.some((h) => hay.includes(h));
}

/**
 * Detect a provider-reported API/agent error in a CLI's output stream.
 *
 * Providers signal failure differently, and a fast-failing rate-limit/quota
 * error frequently exits 0 (or 1) with NO assistant text — only an error
 * payload. Without this, the invocation would be recorded as a silent success
 * with a JSON error blob as its "output". Returns null when no error is found.
 *
 * - `opencode`: a `{type:"error", error:{name, data:{message, statusCode,
 *   isRetryable, ...}}}` event (this is the observed quota_exceeded shape).
 * - `claude`/`amp`: a terminal `result` event with `is_error: true` / `subtype:
 *   "error_*"`, the message in `result`.
 * - `gemini`: a single JSON doc with a top-level `error` field.
 * - `codex`: a top-level `{type:"error", message}` event or a
 *   `{type:"turn.failed", error:{message}}` event; the message is often itself
 *   a nested JSON blob (`{status, error:{message}}`) which is unwrapped. A
 *   soft `{type:"item.completed", item:{type:"error"}}` notice (e.g. fallback
 *   model metadata) is NOT a failure and is ignored.
 */
export function extractError(
  provider: string,
  rawOutput: string,
): ProviderError | null {
  if (provider === "opencode") {
    for (const line of rawOutput.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type !== "error") continue;
        const data = event.error?.data ?? {};
        const message: string = data.message ?? event.error?.message ??
          event.error?.name ?? "opencode reported an error";
        const code = data.statusCode ?? event.error?.name;
        return {
          message,
          code: code !== undefined ? String(code) : undefined,
          // Honor opencode's own flag verbatim. A quota_exceeded (monthly reset,
          // retry-after days away) reports isRetryable:false and must fail fast
          // — retrying it just burns ~18s of backoff during an outage. A genuine
          // transient (429/5xx) reports isRetryable:true and gets retried.
          retryable: data.isRetryable === true,
        };
      } catch { /* not JSON */ }
    }
    return null;
  }

  if (provider === "claude" || provider === "amp") {
    for (const line of rawOutput.split("\n").reverse()) {
      try {
        const event = JSON.parse(line);
        if (event.type !== "result") continue;
        const isError = event.is_error === true ||
          (typeof event.subtype === "string" &&
            event.subtype.startsWith("error"));
        if (!isError) return null;
        const message: string = event.result ?? event.error ??
          `${provider} reported an error (${event.subtype ?? "unknown"})`;
        return {
          message,
          code: event.subtype,
          retryable: looksRateLimited(message, event.subtype),
        };
      } catch { /* not JSON */ }
    }
    return null;
  }

  if (provider === "gemini") {
    try {
      const data = JSON.parse(rawOutput);
      if (!data.error) return null;
      const message: string = typeof data.error === "string"
        ? data.error
        : data.error.message ?? "gemini reported an error";
      const code = typeof data.error === "object"
        ? data.error.code ?? data.error.status
        : undefined;
      return {
        message,
        code: code !== undefined ? String(code) : undefined,
        retryable: looksRateLimited(message, code),
      };
    } catch {
      return null;
    }
  }

  if (provider === "codex") {
    // Forward-scan so an EARLY hard error wins over later events; stop on the
    // first top-level `error` or `turn.failed`. (Unlike claude/amp, codex does
    // not put its error in a terminal `result`, so a reverse scan would miss it.)
    for (const line of rawOutput.split("\n")) {
      try {
        const event = JSON.parse(line);
        // `item.completed` carrying an `error` item is a soft degradation
        // notice (e.g. fallback model metadata), not a turn failure — skip it.
        if (event.type !== "error" && event.type !== "turn.failed") continue;
        let message: string = event.type === "turn.failed"
          ? event.error?.message ?? "codex turn failed"
          : event.message ?? "codex reported an error";
        let code: string | number | undefined;
        // The message is frequently a nested JSON blob; unwrap it.
        try {
          const inner = JSON.parse(message);
          code = inner.status ?? inner.error?.code ?? inner.error?.type;
          message = inner.error?.message ?? inner.message ?? message;
        } catch { /* message is plain text */ }
        return {
          message,
          code: code !== undefined ? String(code) : undefined,
          retryable: looksRateLimited(message, code),
        };
      } catch { /* not JSON */ }
    }
    return null;
  }

  return null;
}

/** Token and cost usage data extracted from provider output. */
export interface UsageData {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  reasoning?: number;
  costUsd?: number;
}

/**
 * Extract token usage and cost information from a provider's raw output.
 *
 * Each provider reports usage in a different shape; this normalizes them to a
 * common {@link UsageData}. Token accounting matches the ADW Ruby
 * `usage_extractor` so the two systems stay consistent: cache-read tokens fold
 * into `input` (the model still attends to them) and `total` includes both
 * cache reads and writes.
 *
 * - `claude`: one terminal `result` event with a `usage` object; cost lives in
 *   `total_cost_usd` (NOT `cost_usd`, which the CLI always emits as null).
 * - `opencode`: one `step_finish` event per turn, each with a `part.tokens`
 *   object and `part.cost` — usage is the SUM across all such events. This is
 *   opencode's own event schema, identical for the Ollama and Copilot backends
 *   (only the values differ; local models report `cost: 0`).
 * - `amp`: Claude-Code-compatible stream JSON. Usage lives on `assistant`
 *   events at `message.usage` (Claude field names), summed across turns. Amp
 *   does not report cost, so `costUsd` is left undefined.
 * - `gemini`: a single JSON document with `stats.models.<name>.tokens`. No cost.
 * - `codex`: the terminal `turn.completed` event carries a `usage` object
 *   (`input_tokens`, `cached_input_tokens`, `output_tokens`,
 *   `reasoning_output_tokens`). No cost. Cached input folds into `input` like
 *   the other providers.
 */
export function extractUsage(provider: string, rawOutput: string): UsageData {
  if (provider === "claude") {
    for (const line of rawOutput.split("\n").reverse()) {
      try {
        const event = JSON.parse(line);
        if (event.type === "result" && event.usage) {
          const u = event.usage;
          const input = Number(u.input_tokens) || 0;
          const output = Number(u.output_tokens) || 0;
          const cacheRead = Number(u.cache_read_input_tokens) || 0;
          const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
          return {
            // Fold cache reads into input to match the Ruby usage_extractor.
            input: input + cacheRead,
            output,
            cacheRead,
            cacheWrite,
            total: input + output + cacheRead + cacheWrite,
            // The Claude CLI reports cost in `total_cost_usd`; `cost_usd` is
            // always null.
            costUsd: event.total_cost_usd,
          };
        }
      } catch { /* skip */ }
    }
    return {};
  }

  if (provider === "amp") {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let sawUsage = false;

    for (const line of rawOutput.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type !== "assistant") continue;
        const u = event.message?.usage;
        if (!u) continue;
        input += Number(u.input_tokens) || 0;
        output += Number(u.output_tokens) || 0;
        cacheRead += Number(u.cache_read_input_tokens) || 0;
        cacheWrite += Number(u.cache_creation_input_tokens) || 0;
        sawUsage = true;
      } catch { /* skip */ }
    }

    if (!sawUsage) return {};
    return {
      // Fold cache reads into input to match the Ruby usage_extractor.
      input: input + cacheRead,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
      // Amp does not report per-invocation cost.
    };
  }

  if (provider === "gemini") {
    try {
      const data = JSON.parse(rawOutput);
      const models = data.stats?.models ?? {};
      const modelName = Object.keys(models)[0];
      if (!modelName) return {};
      const tokens = models[modelName]?.tokens ?? {};
      const input = Number(tokens.input) || 0;
      const cached = Number(tokens.cached) || 0;
      return {
        // Fold cached tokens into input, mirroring the Ruby gemini extractor.
        input: input + cached,
        output: Number(tokens.candidates) || 0,
        cacheRead: cached,
        cacheWrite: 0,
        reasoning: Number(tokens.thoughts) || 0,
        total: Number(tokens.total) || 0,
        // Gemini does not report cost.
      };
    } catch {
      return {};
    }
  }

  if (provider === "opencode") {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let reasoning = 0;
    let costUsd = 0;
    let sawStep = false;

    for (const line of rawOutput.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type !== "step_finish") continue;
        const tokens = event.part?.tokens ?? {};
        input += Number(tokens.input) || 0;
        output += Number(tokens.output) || 0;
        reasoning += Number(tokens.reasoning) || 0;
        cacheRead += Number(tokens.cache?.read) || 0;
        cacheWrite += Number(tokens.cache?.write) || 0;
        costUsd += Number(event.part?.cost) || 0;
        sawStep = true;
      } catch { /* skip */ }
    }

    if (!sawStep) return {};
    return {
      // Cache reads are input the model still had to attend to; fold them in
      // to match the ADW Ruby usage_extractor's accounting.
      input: input + cacheRead,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      total: input + output + cacheRead + cacheWrite,
      costUsd,
    };
  }

  if (provider === "codex") {
    // codex emits one `turn.completed` per turn; sum usage across all of them
    // (like amp/opencode) rather than reading a single event, so a multi-turn
    // run is not undercounted.
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    // codex reports no cache writes, so this stays 0 — but it is a named
    // counter (not a literal) so the four-term `total` below reads identically
    // to the sibling providers.
    const cacheWrite = 0;
    let reasoning = 0;
    let sawUsage = false;

    for (const line of rawOutput.split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.type !== "turn.completed" || !event.usage) continue;
        const u = event.usage;
        input += Number(u.input_tokens) || 0;
        cacheRead += Number(u.cached_input_tokens) || 0;
        output += Number(u.output_tokens) || 0;
        reasoning += Number(u.reasoning_output_tokens) || 0;
        sawUsage = true;
      } catch { /* skip */ }
    }

    if (!sawUsage) return {};
    return {
      // Raw input is the basis for `total`; the returned `input` field folds
      // cache reads in (matching the other providers). Using the folded value
      // in `total` would double-count cached_input_tokens.
      input: input + cacheRead,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      total: input + output + cacheRead + cacheWrite,
      // codex does not report per-invocation cost.
    };
  }

  return {};
}

/** The supported provider names as a string-literal union. */
type Provider = "claude" | "opencode" | "amp" | "gemini" | "codex";

/** A command-builder for a provider's CLI. */
type CommandBuilder = (
  cliPath: string,
  model: string,
  resolvedPrompt: string,
) => { cmd: string[]; stdin?: string };

/** Provider CLI path lookup, keyed by provider name. */
function cliPathFor(
  provider: Provider,
  g: z.infer<typeof GlobalArgsSchema>,
): string {
  const paths: Record<Provider, string> = {
    claude: g.claudePath,
    opencode: g.opencodePath,
    amp: g.ampPath,
    gemini: g.geminiPath,
    codex: g.codexPath,
  };
  return paths[provider];
}

/** Command-builder lookup, keyed by provider name. */
function builderFor(provider: Provider): CommandBuilder {
  const builders: Record<Provider, CommandBuilder> = {
    claude: buildClaudeCommand,
    opencode: buildOpencodeCommand,
    amp: buildAmpCommand,
    gemini: buildGeminiCommand,
    codex: buildCodexCommand,
  };
  return builders[provider];
}

/** The fully-resolved outcome of running a provider CLI (with retries). */
type RunOutcome = {
  result: CmdResult;
  retries: number;
  /** Detected provider-level API/agent error, if any. */
  providerError: ProviderError | null;
  /** Text extracted from the output (or the error message on a provider error). */
  extractedText: string;
  usage: UsageData;
  /** True when the CLI exited cleanly AND no provider error was reported. */
  ok: boolean;
};

/**
 * Run a provider CLI with retries, then detect provider-reported errors.
 *
 * Retries cover two distinct transient failure modes:
 * - a transient *exit code* (137/143 — killed by signal), and
 * - a *retryable provider error* surfaced in the output stream (rate limit /
 *   quota / overloaded / 429), which the CLI itself does not retry and which
 *   typically exits non-transiently (e.g. 1) with zero assistant text.
 *
 * The second is the case that previously slipped through as a silent success:
 * the subprocess "succeeded" enough to exit, but the model never answered.
 */
async function runWithRetries(
  provider: Provider,
  cliPath: string,
  modelName: string,
  resolved: string,
  opts: {
    cwd: string;
    wallTimeoutMs: number;
    idleTimeoutMs: number;
    maxRetries: number;
  },
  logger?: MethodContext["logger"],
): Promise<RunOutcome> {
  const buildCommand = builderFor(provider);
  let lastResult: CmdResult | undefined;
  let providerError: ProviderError | null = null;
  let retries = 0;

  while (retries <= opts.maxRetries) {
    const { cmd, stdin } = buildCommand(cliPath, modelName, resolved);
    lastResult = await runCli(cmd, {
      cwd: opts.cwd,
      stdin,
      wallTimeoutMs: opts.wallTimeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
    });
    providerError = extractError(provider, lastResult.stdout);

    const transientExit = !lastResult.success &&
      TRANSIENT_EXIT_CODES.has(lastResult.code);
    const retryableProviderError = providerError?.retryable === true;

    if (!transientExit && !retryableProviderError) break;

    retries++;
    if (retries <= opts.maxRetries) {
      logger?.warning(
        "Transient failure ({reason}), retrying ({retries}/{max})",
        {
          reason: retryableProviderError
            ? `provider:${providerError?.code ?? "rate_limit"}`
            : `exit ${lastResult.code}`,
          retries,
          max: opts.maxRetries,
        },
      );
      await new Promise((r) => setTimeout(r, 5000 * retries));
    }
  }

  const result = lastResult!;
  const extractedText = extractTextFromOutput(provider, result.stdout);
  const usage = extractUsage(provider, result.stdout);
  const ok = result.success && providerError === null;

  return { result, retries, providerError, extractedText, usage, ok };
}

/** Build the common invocation record fields shared by invoke/invokeAndParse. */
function buildInvocationBase(
  invocationId: string,
  provider: string,
  modelName: string,
  args: { prompt: string; tags?: Record<string, string> },
  promptHash: string,
  slashCommand: string | undefined,
  cwd: string,
  outcome: RunOutcome,
): Record<string, unknown> {
  const { result, usage, providerError, extractedText } = outcome;
  const outputTokensPerSecond = usage.output && result.durationMs > 0
    ? Math.round((usage.output / (result.durationMs / 1000)) * 100) / 100
    : undefined;

  return {
    invocationId,
    provider,
    model: modelName,
    prompt: args.prompt.slice(0, 500),
    promptHash,
    slashCommand,
    cwd,
    exitCode: result.code,
    // A provider error (quota/rate-limit) is a failure even when the CLI
    // exited 0 — the model never produced an answer.
    success: outcome.ok,
    durationMs: result.durationMs,
    outputBytes: result.stdout.length,
    outputPreview: extractedText.slice(0, 1000),
    outputTokensPerSecond,
    retries: outcome.retries,
    timedOut: result.timedOut,
    timeoutReason: result.timeoutReason,
    failureReason: providerError
      ? `provider_error:${providerError.code ?? "unknown"}`
      : result.timedOut
      ? result.timeoutReason
      : !result.success
      ? `exit_${result.code}`
      : undefined,
    invokedAt: new Date().toISOString(),
    tokens: usage.total
      ? {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        total: usage.total,
        reasoning: usage.reasoning,
      }
      : undefined,
    costUsd: usage.costUsd,
    tags: args.tags,
  };
}

/** Execution context provided by swamp to each method invocation. */
type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

/**
 * Swamp model definition for `@mgreten/cli-agent`.
 *
 * Provides three methods:
 * - `invoke` — run a CLI agent and record structured results
 * - `invokeAndParse` — run a CLI agent and parse JSON from the output
 * - `listModels` — enumerate the models available to a provider's CLI
 */
export const model = {
  type: "@mgreten/cli-agent",
  version: "2026.06.25.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    invocation: {
      description:
        "Structured record of a CLI agent invocation with provider, tokens, cost, and output",
      schema: InvocationSchema,
      lifetime: "30d" as const,
      garbageCollection: 100,
    },
    transcript: {
      description:
        "Full untruncated prompt and output for an invocation (companion to the invocation record)",
      schema: TranscriptSchema,
      lifetime: "30d" as const,
      garbageCollection: 100,
    },
    modelList: {
      description: "Models available to a provider's CLI",
      schema: ModelListSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    invoke: {
      description:
        "Run a CLI agent tool (claude, opencode, amp, gemini, codex) with a prompt and record structured results",
      arguments: z.object({
        prompt: z.string().describe("The prompt or slash command to execute"),
        provider: ProviderEnum.optional().describe(
          "Override the default provider",
        ),
        model: z.string().optional().describe(
          "Override the default model (e.g. 'opus', 'sonnet', 'ollama/qwen3.6:35b')",
        ),
        cwd: z.string().optional().describe(
          "Working directory for the CLI (defaults to Deno.cwd())",
        ),
        tags: z.record(z.string(), z.string()).optional().describe(
          "Arbitrary key-value tags for grouping/filtering invocations",
        ),
        wallTimeoutMs: z.number().optional().describe(
          "Override wall timeout in milliseconds",
        ),
      }),
      execute: async (
        args: {
          prompt: string;
          provider?: string;
          model?: string;
          cwd?: string;
          tags?: Record<string, string>;
          wallTimeoutMs?: number;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const provider =
          (args.provider || context.globalArgs.defaultProvider) as Provider;
        const modelName = args.model || context.globalArgs.defaultModel;
        const cwd = args.cwd || Deno.cwd();
        const wallTimeoutMs = args.wallTimeoutMs ||
          context.globalArgs.wallTimeoutMs;
        const idleTimeoutMs = context.globalArgs.idleTimeoutMs;
        const maxRetries = context.globalArgs.maxRetries;
        const commandsDir = context.globalArgs.commandsDir;
        const commandSubdirs = context.globalArgs.commandSubdirs;

        const { resolved, slashCommand } = await resolveSlashCommand(
          args.prompt,
          commandsDir,
          commandSubdirs,
          cwd,
        );
        const promptHash = hashPrompt(resolved);
        const cliPath = cliPathFor(provider, context.globalArgs);

        const outcome = await runWithRetries(
          provider,
          cliPath,
          modelName,
          resolved,
          { cwd, wallTimeoutMs, idleTimeoutMs, maxRetries },
          context.logger,
        );

        const invocationId = uuid();
        const invocation = buildInvocationBase(
          invocationId,
          provider,
          modelName,
          args,
          promptHash,
          slashCommand,
          cwd,
          outcome,
        );

        const handle = await context.writeResource(
          "invocation",
          `invocation-${invocationId}`,
          invocation,
        );
        const transcriptHandle = await context.writeResource(
          "transcript",
          `transcript-${invocationId}`,
          {
            invocationId,
            prompt: args.prompt,
            output: outcome.extractedText,
          },
        );

        const { result, providerError } = outcome;
        context.logger.info(
          "{provider}/{model}: {status} ({ms}ms, {bytes}b, {retries} retries)",
          {
            provider,
            model: modelName,
            status: outcome.ok
              ? "ok"
              : providerError
              ? `provider_error ${providerError.code ?? ""}`
              : result.timedOut
              ? result.timeoutReason
              : `exit ${result.code}`,
            ms: result.durationMs,
            bytes: result.stdout.length,
            retries: outcome.retries,
          },
        );

        // Surface failure to the caller: a provider error (quota/rate-limit), a
        // timeout, or a non-zero exit. The artifacts above are already
        // persisted for audit/telemetry before we throw.
        if (!outcome.ok) {
          if (providerError) {
            throw new Error(
              `${provider} provider error${
                providerError.code ? ` (${providerError.code})` : ""
              }: ${providerError.message.slice(0, 300)}`,
            );
          }
          if (result.timedOut) {
            throw new Error(
              `${provider} CLI ${result.timeoutReason} after ${result.durationMs}ms (no answer produced)`,
            );
          }
          throw new Error(
            `${provider} CLI failed (exit ${result.code}): ${
              result.stderr.slice(0, 200)
            }`,
          );
        }

        return { dataHandles: [handle, transcriptHandle] };
      },
    },

    invokeAndParse: {
      description:
        "Run a CLI agent and parse the JSON response from the output. Returns the parsed data alongside the invocation record.",
      arguments: z.object({
        prompt: z.string(),
        provider: ProviderEnum.optional(),
        model: z.string().optional(),
        cwd: z.string().optional(),
        tags: z.record(z.string(), z.string()).optional(),
        wallTimeoutMs: z.number().optional(),
      }),
      execute: async (
        args: {
          prompt: string;
          provider?: string;
          model?: string;
          cwd?: string;
          tags?: Record<string, string>;
          wallTimeoutMs?: number;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const provider =
          (args.provider || context.globalArgs.defaultProvider) as Provider;
        const modelName = args.model || context.globalArgs.defaultModel;
        const cwd = args.cwd || Deno.cwd();
        const wallTimeoutMs = args.wallTimeoutMs ||
          context.globalArgs.wallTimeoutMs;
        const idleTimeoutMs = context.globalArgs.idleTimeoutMs;
        const maxRetries = context.globalArgs.maxRetries;
        const commandsDir = context.globalArgs.commandsDir;
        const commandSubdirs = context.globalArgs.commandSubdirs;

        const { resolved, slashCommand } = await resolveSlashCommand(
          args.prompt,
          commandsDir,
          commandSubdirs,
          cwd,
        );
        const promptHash = hashPrompt(resolved);
        const cliPath = cliPathFor(provider, context.globalArgs);

        const outcome = await runWithRetries(
          provider,
          cliPath,
          modelName,
          resolved,
          { cwd, wallTimeoutMs, idleTimeoutMs, maxRetries },
          context.logger,
        );
        const { result, extractedText, providerError } = outcome;

        // Parse JSON from extracted text
        let parsedJson: Record<string, unknown> | null = null;
        const jsonMatch = extractedText.match(
          /```(?:json)?\s*\n?([\s\S]*?)\n?```/,
        );
        const jsonStr = jsonMatch
          ? jsonMatch[1].trim()
          : extractedText.match(/\{[\s\S]*\}/)?.[0];
        if (jsonStr) {
          try {
            parsedJson = JSON.parse(jsonStr);
          } catch { /* not valid JSON */ }
        }

        const invocationId = uuid();
        const invocation = {
          ...buildInvocationBase(
            invocationId,
            provider,
            modelName,
            args,
            promptHash,
            slashCommand,
            cwd,
            outcome,
          ),
          // invokeAndParse additionally requires a parseable JSON payload.
          success: outcome.ok && parsedJson !== null,
          parsedResponse: parsedJson,
        };

        const handle = await context.writeResource(
          "invocation",
          `invocation-${invocationId}`,
          invocation,
        );
        const transcriptHandle = await context.writeResource(
          "transcript",
          `transcript-${invocationId}`,
          { invocationId, prompt: args.prompt, output: extractedText },
        );

        if (!outcome.ok) {
          if (providerError) {
            throw new Error(
              `${provider} provider error${
                providerError.code ? ` (${providerError.code})` : ""
              }: ${providerError.message.slice(0, 300)}`,
            );
          }
          if (result.timedOut) {
            throw new Error(
              `${provider} CLI ${result.timeoutReason} after ${result.durationMs}ms (no answer produced)`,
            );
          }
          throw new Error(
            `CLI failed (exit ${result.code}): ${result.stderr.slice(0, 200)}`,
          );
        }
        if (!parsedJson) {
          throw new Error(
            `No parseable JSON in output (${extractedText.slice(0, 100)}...)`,
          );
        }

        context.logger.info(
          "{provider}/{model}: parsed ok ({ms}ms, {retries} retries)",
          {
            provider,
            model: modelName,
            ms: result.durationMs,
            retries: outcome.retries,
          },
        );

        return { dataHandles: [handle, transcriptHandle] };
      },
    },

    listModels: {
      description:
        "List the model identifiers available to a provider's CLI (currently opencode only)",
      arguments: z.object({
        provider: ProviderEnum.optional().describe(
          "Provider to enumerate (defaults to the configured defaultProvider)",
        ),
      }),
      execute: async (
        args: { provider?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const provider =
          (args.provider || context.globalArgs.defaultProvider) as Provider;

        if (provider !== "opencode") {
          throw new Error(
            `Model enumeration is not supported for '${provider}' — its CLI has no model-listing command. Use provider 'opencode'.`,
          );
        }

        const result = await runCli(
          [context.globalArgs.opencodePath, "models"],
          { wallTimeoutMs: 60_000 },
        );
        if (!result.success) {
          throw new Error(
            `opencode models failed (exit ${result.code}): ${
              result.stderr.slice(0, 200)
            }`,
          );
        }

        const models = result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        const handle = await context.writeResource(
          "modelList",
          `models-${provider}`,
          {
            provider,
            models,
            count: models.length,
            listedAt: new Date().toISOString(),
          },
        );

        context.logger.info("{provider}: {count} models available", {
          provider,
          count: models.length,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
