/**
 * Multi-provider CLI agent invoker for swamp.
 *
 * Runs coding-agent CLI tools (claude, opencode, amp, gemini) with typed
 * inputs, captures structured outputs including token counts, cost, duration,
 * exit code, and automatic retries on transient failures. Supports slash
 * command resolution from a configurable commands directory and optional JSON
 * response parsing.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Supported CLI agent providers. */
const ProviderEnum: z.ZodEnum<["claude", "opencode", "amp", "gemini"]> = z.enum(
  [
    "claude",
    "opencode",
    "amp",
    "gemini",
  ],
);

/** Global configuration arguments shared across all method invocations. */
const GlobalArgsSchema: z.ZodObject<{
  defaultProvider: z.ZodDefault<typeof ProviderEnum>;
  defaultModel: z.ZodDefault<z.ZodString>;
  commandsDir: z.ZodDefault<z.ZodString>;
  commandSubdirs: z.ZodDefault<z.ZodArray<z.ZodString>>;
  claudePath: z.ZodDefault<z.ZodString>;
  opencodePath: z.ZodDefault<z.ZodString>;
  ampPath: z.ZodDefault<z.ZodString>;
  geminiPath: z.ZodDefault<z.ZodString>;
  idleTimeoutMs: z.ZodDefault<z.ZodNumber>;
  wallTimeoutMs: z.ZodDefault<z.ZodNumber>;
  maxRetries: z.ZodDefault<z.ZodNumber>;
}> = z.object({
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
  idleTimeoutMs: z.number().default(600_000),
  wallTimeoutMs: z.number().default(3_600_000),
  maxRetries: z.number().default(2),
});

/** Schema for a structured invocation record persisted as a swamp resource. */
const InvocationSchema: z.ZodObject<{
  invocationId: z.ZodString;
  provider: typeof ProviderEnum;
  model: z.ZodString;
  prompt: z.ZodString;
  promptHash: z.ZodString;
  slashCommand: z.ZodOptional<z.ZodString>;
  cwd: z.ZodString;
  exitCode: z.ZodNumber;
  success: z.ZodBoolean;
  durationMs: z.ZodNumber;
  outputBytes: z.ZodNumber;
  outputPreview: z.ZodString;
  outputTokensPerSecond: z.ZodOptional<z.ZodNumber>;
  retries: z.ZodNumber;
  timedOut: z.ZodBoolean;
  timeoutReason: z.ZodOptional<z.ZodString>;
  invokedAt: z.ZodString;
  tokens: z.ZodOptional<
    z.ZodObject<{
      input: z.ZodOptional<z.ZodNumber>;
      output: z.ZodOptional<z.ZodNumber>;
      cacheRead: z.ZodOptional<z.ZodNumber>;
      cacheWrite: z.ZodOptional<z.ZodNumber>;
      total: z.ZodOptional<z.ZodNumber>;
      reasoning: z.ZodOptional<z.ZodNumber>;
    }>
  >;
  costUsd: z.ZodOptional<z.ZodNumber>;
  tags: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}> = z.object({
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
const TranscriptSchema: z.ZodObject<{
  invocationId: z.ZodString;
  prompt: z.ZodString;
  output: z.ZodString;
}> = z.object({
  invocationId: z.string(),
  prompt: z.string(),
  output: z.string(),
}).passthrough();

/** Schema for the result of enumerating a provider's available models. */
const ModelListSchema: z.ZodObject<{
  provider: typeof ProviderEnum;
  models: z.ZodArray<z.ZodString>;
  count: z.ZodNumber;
  listedAt: z.ZodString;
}> = z.object({
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

/**
 * Spawn a CLI subprocess with optional stdin and a wall-clock timeout.
 * Returns structured output including whether the process was killed.
 */
async function runCli(
  cmd: string[],
  opts: {
    cwd?: string;
    stdin?: string;
    wallTimeoutMs: number;
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

  const timeoutId = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch { /* already dead */ }
  }, opts.wallTimeoutMs);

  const output = await child.output();
  clearTimeout(timeoutId);
  const durationMs = Math.round(performance.now() - start);
  const timedOut = durationMs >= opts.wallTimeoutMs - 100;

  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
    success: output.success,
    timedOut,
    timeoutReason: timedOut ? "wall_time_exceeded" : undefined,
    durationMs,
  };
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
    return parts.length > 0 ? parts.join("") : rawOutput;
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
  return rawOutput;
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

  return {};
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
  version: "2026.06.17.1",
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
        "Run a CLI agent tool (claude, opencode, amp, gemini) with a prompt and record structured results",
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
          (args.provider || context.globalArgs.defaultProvider) as z.infer<
            typeof ProviderEnum
          >;
        const modelName = args.model || context.globalArgs.defaultModel;
        const cwd = args.cwd || Deno.cwd();
        const wallTimeoutMs = args.wallTimeoutMs ||
          context.globalArgs.wallTimeoutMs;
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

        const cliPath: string = {
          claude: context.globalArgs.claudePath,
          opencode: context.globalArgs.opencodePath,
          amp: context.globalArgs.ampPath,
          gemini: context.globalArgs.geminiPath,
        }[provider];

        const buildCommand: (
          cliPath: string,
          model: string,
          resolvedPrompt: string,
        ) => { cmd: string[]; stdin?: string } = {
          claude: buildClaudeCommand,
          opencode: buildOpencodeCommand,
          amp: buildAmpCommand,
          gemini: buildGeminiCommand,
        }[provider];

        let lastResult: CmdResult | undefined;
        let retries = 0;

        while (retries <= maxRetries) {
          const { cmd, stdin } = buildCommand(cliPath, modelName, resolved);
          lastResult = await runCli(cmd, { cwd, stdin, wallTimeoutMs });

          if (
            lastResult.success || !TRANSIENT_EXIT_CODES.has(lastResult.code)
          ) {
            break;
          }

          retries++;
          if (retries <= maxRetries) {
            context.logger.warning(
              "Transient failure, retrying ({retries}/{max})",
              {
                retries,
                max: maxRetries,
              },
            );
            await new Promise((r) => setTimeout(r, 5000 * retries));
          }
        }

        const result = lastResult!;
        const rawOutput = result.stdout;
        const extractedText = extractTextFromOutput(provider, rawOutput);
        const usage = extractUsage(provider, rawOutput);
        const invocationId = uuid();
        const outputTokensPerSecond = usage.output && result.durationMs > 0
          ? Math.round((usage.output / (result.durationMs / 1000)) * 100) / 100
          : undefined;

        const invocation = {
          invocationId,
          provider,
          model: modelName,
          prompt: args.prompt.slice(0, 500),
          promptHash,
          slashCommand,
          cwd,
          exitCode: result.code,
          success: result.success,
          durationMs: result.durationMs,
          outputBytes: rawOutput.length,
          outputPreview: extractedText.slice(0, 1000),
          outputTokensPerSecond,
          retries,
          timedOut: result.timedOut,
          timeoutReason: result.timeoutReason,
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

        const handle = await context.writeResource(
          "invocation",
          `invocation-${invocationId}`,
          invocation as unknown as Record<string, unknown>,
        );
        const transcriptHandle = await context.writeResource(
          "transcript",
          `transcript-${invocationId}`,
          { invocationId, prompt: args.prompt, output: extractedText },
        );

        context.logger.info(
          "{provider}/{model}: {status} ({ms}ms, {bytes}b, {retries} retries)",
          {
            provider,
            model: modelName,
            status: result.success ? "ok" : `exit ${result.code}`,
            ms: result.durationMs,
            bytes: rawOutput.length,
            retries,
          },
        );

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
          (args.provider || context.globalArgs.defaultProvider) as z.infer<
            typeof ProviderEnum
          >;
        const modelName = args.model || context.globalArgs.defaultModel;
        const cwd = args.cwd || Deno.cwd();
        const wallTimeoutMs = args.wallTimeoutMs ||
          context.globalArgs.wallTimeoutMs;
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

        const cliPath: string = {
          claude: context.globalArgs.claudePath,
          opencode: context.globalArgs.opencodePath,
          amp: context.globalArgs.ampPath,
          gemini: context.globalArgs.geminiPath,
        }[provider];

        const buildCommand: (
          cliPath: string,
          model: string,
          resolvedPrompt: string,
        ) => { cmd: string[]; stdin?: string } = {
          claude: buildClaudeCommand,
          opencode: buildOpencodeCommand,
          amp: buildAmpCommand,
          gemini: buildGeminiCommand,
        }[provider];

        let lastResult: CmdResult | undefined;
        let retries = 0;

        while (retries <= maxRetries) {
          const { cmd, stdin } = buildCommand(cliPath, modelName, resolved);
          lastResult = await runCli(cmd, { cwd, stdin, wallTimeoutMs });

          if (
            lastResult.success || !TRANSIENT_EXIT_CODES.has(lastResult.code)
          ) break;
          retries++;
          if (retries <= maxRetries) {
            await new Promise((r) => setTimeout(r, 5000 * retries));
          }
        }

        const result = lastResult!;
        const rawOutput = result.stdout;
        const extractedText = extractTextFromOutput(provider, rawOutput);
        const usage = extractUsage(provider, rawOutput);
        const invocationId = uuid();
        const outputTokensPerSecond = usage.output && result.durationMs > 0
          ? Math.round((usage.output / (result.durationMs / 1000)) * 100) / 100
          : undefined;

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

        const invocation = {
          invocationId,
          provider,
          model: modelName,
          prompt: args.prompt.slice(0, 500),
          promptHash,
          slashCommand,
          cwd,
          exitCode: result.code,
          success: result.success && parsedJson !== null,
          durationMs: result.durationMs,
          outputBytes: rawOutput.length,
          outputPreview: extractedText.slice(0, 1000),
          outputTokensPerSecond,
          retries,
          timedOut: result.timedOut,
          timeoutReason: result.timeoutReason,
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
          parsedResponse: parsedJson,
        };

        const handle = await context.writeResource(
          "invocation",
          `invocation-${invocationId}`,
          invocation as unknown as Record<string, unknown>,
        );
        const transcriptHandle = await context.writeResource(
          "transcript",
          `transcript-${invocationId}`,
          { invocationId, prompt: args.prompt, output: extractedText },
        );

        if (!result.success) {
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
            retries,
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
          (args.provider || context.globalArgs.defaultProvider) as z.infer<
            typeof ProviderEnum
          >;

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
