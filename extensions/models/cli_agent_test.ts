/**
 * Unit tests for the provider-specific usage and text extractors.
 *
 * The JSONL/JSON fixtures below are real captures from each CLI run against a
 * trivial "reply with hi" prompt, trimmed to the fields the extractors read.
 * They are the ground truth for the per-provider parsing in `cli_agent.ts`.
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildClaudeCommand,
  buildGrokCommand,
  extractError,
  extractTextFromOutput,
  extractUsage,
  GlobalArgsSchema,
  isProvider,
  listProvidersFromRegistry,
  ModelIdSchema,
  parseGrokModelsList,
  PROVIDERS,
  resolveModel,
  SANDBOX_PROFILE_FILENAME,
  sandboxConfigFrom,
  wrapWithSandbox,
} from "./cli_agent.ts";

// --- Fixtures ---------------------------------------------------------------

// Claude `--output-format stream-json`: the terminal `result` event carries
// `usage` and `total_cost_usd` (NOT `cost_usd`, which the CLI emits as null).
const CLAUDE_RESULT = JSON.stringify({
  type: "result",
  subtype: "success",
  result: "hi",
  num_turns: 1,
  cost_usd: null,
  total_cost_usd: 0.051505,
  usage: {
    input_tokens: 3,
    cache_creation_input_tokens: 25741,
    cache_read_input_tokens: 0,
    output_tokens: 4,
  },
});
const CLAUDE_OUTPUT = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({ type: "assistant", message: { content: [] } }),
  CLAUDE_RESULT,
].join("\n");

// Amp `-x --stream-json`: Claude-Code-compatible stream JSON. Token usage is on
// `assistant` events under `message.usage` (Claude field names); the `result`
// event has no usage and no cost. Two assistant turns exercise summing.
const AMP_OUTPUT = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hi?" }] },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "think" }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 48383,
        cache_read_input_tokens: 0,
        output_tokens: 5,
      },
    },
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 48383,
        output_tokens: 4,
      },
    },
  }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "hi",
    num_turns: 2,
  }),
].join("\n");

// Gemini `-o json`: a single JSON document with stats.models.<name>.tokens.
const GEMINI_OUTPUT = JSON.stringify({
  response: "hi",
  stats: {
    models: {
      "gemini-2.5-flash": {
        api: { totalRequests: 1, totalLatencyMs: 1658 },
        tokens: {
          input: 8693,
          candidates: 1,
          total: 8723,
          cached: 0,
          thoughts: 29,
        },
      },
    },
  },
});

// Opencode `run --format json`: one `step_finish` event per turn with
// `part.tokens` and `part.cost`. Two steps exercise summing. Shape is identical
// across the Ollama and Copilot backends; only the values differ.
const OPENCODE_OUTPUT = [
  JSON.stringify({ type: "text", part: { text: "hi" } }),
  JSON.stringify({
    type: "step_finish",
    part: {
      cost: 0.0012,
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 30, write: 10 },
      },
    },
  }),
  JSON.stringify({
    type: "step_finish",
    part: {
      cost: 0.0008,
      tokens: {
        input: 50,
        output: 10,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
  }),
].join("\n");

// Codex `exec --json`: JSONL. The answer is the last item.completed
// agent_message; usage is on the terminal turn.completed event. Real capture
// trimmed to the fields the extractors read.
const CODEX_OUTPUT = [
  JSON.stringify({ type: "thread.started", thread_id: "t_x" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "hi" },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 13742,
      cached_input_tokens: 4992,
      output_tokens: 22,
      reasoning_output_tokens: 14,
    },
  }),
].join("\n");

// Codex multi-turn run: two turn.completed events. Usage must be SUMMED across
// both turns, not read from the first one only.
const CODEX_MULTITURN = [
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 100,
      cached_input_tokens: 10,
      output_tokens: 5,
      reasoning_output_tokens: 2,
    },
  }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 200,
      cached_input_tokens: 20,
      output_tokens: 8,
      reasoning_output_tokens: 3,
    },
  }),
].join("\n");

// Codex turn failure: a soft item.completed error notice (which must be
// ignored) followed by a turn.failed carrying a nested-JSON message. Real
// capture from a bad `-m` model id.
const CODEX_TURN_FAILED = [
  JSON.stringify({ type: "thread.started", thread_id: "t_x" }),
  // Soft degradation notice — must NOT be treated as a failure.
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "error", message: "fallback model metadata" },
  }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "turn.failed",
    error: {
      message:
        '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported."}}',
    },
  }),
].join("\n");

// Codex top-level rate-limit error event (no turn.failed, no agent_message).
const CODEX_RATE_LIMIT = JSON.stringify({
  type: "error",
  message: '{"status":429,"error":{"message":"Rate limit exceeded"}}',
});

// --- extractUsage -----------------------------------------------------------

Deno.test("extractUsage: claude reads total_cost_usd and folds cache read into input", () => {
  const u = extractUsage("claude", CLAUDE_OUTPUT);
  // input(3) + cacheRead(0) folded
  assertEquals(u.input, 3);
  assertEquals(u.output, 4);
  assertEquals(u.cacheRead, 0);
  assertEquals(u.cacheWrite, 25741);
  // input(3) + output(4) + cacheRead(0) + cacheWrite(25741)
  assertEquals(u.total, 25748);
  // The bug being fixed: cost comes from total_cost_usd, not cost_usd (null).
  assertEquals(u.costUsd, 0.051505);
});

Deno.test("extractUsage: amp sums assistant usage across turns, no cost", () => {
  const u = extractUsage("amp", AMP_OUTPUT);
  // input(2+10) + cacheRead(0+48383) folded = 12 + 48383
  assertEquals(u.input, 48395);
  assertEquals(u.output, 9);
  assertEquals(u.cacheRead, 48383);
  assertEquals(u.cacheWrite, 48383);
  // input(12) + output(9) + cacheRead(48383) + cacheWrite(48383)
  assertEquals(u.total, 96787);
  // Amp does not report cost.
  assertEquals(u.costUsd, undefined);
});

Deno.test("extractUsage: gemini reads stats.models tokens, no cost", () => {
  const u = extractUsage("gemini", GEMINI_OUTPUT);
  // input(8693) + cached(0) folded
  assertEquals(u.input, 8693);
  assertEquals(u.output, 1);
  assertEquals(u.cacheRead, 0);
  assertEquals(u.cacheWrite, 0);
  assertEquals(u.reasoning, 29);
  assertEquals(u.total, 8723);
  assertEquals(u.costUsd, undefined);
});

Deno.test("extractUsage: opencode sums step_finish tokens and cost", () => {
  const u = extractUsage("opencode", OPENCODE_OUTPUT);
  // input(100+50) + cacheRead(30+0) folded
  assertEquals(u.input, 180);
  assertEquals(u.output, 30);
  assertEquals(u.cacheRead, 30);
  assertEquals(u.cacheWrite, 10);
  assertEquals(u.reasoning, 5);
  // input(150) + output(30) + cacheRead(30) + cacheWrite(10)
  assertEquals(u.total, 220);
  // 0.0012 + 0.0008, allowing for float
  assertEquals(Math.round((u.costUsd ?? 0) * 10000), 20);
});

Deno.test("extractUsage: codex reads turn.completed usage, folds cached into input, no double-count, no cost", () => {
  const u = extractUsage("codex", CODEX_OUTPUT);
  // input(13742) + cached(4992) folded into the input field
  assertEquals(u.input, 18734);
  assertEquals(u.output, 22);
  assertEquals(u.cacheRead, 4992);
  assertEquals(u.cacheWrite, 0);
  assertEquals(u.reasoning, 14);
  // total uses RAW input: 13742 + 22 + 4992 — NOT the folded 18734 (which
  // would be 23748 and double-count the cached tokens).
  assertEquals(u.total, 18756);
  // codex does not report cost.
  assertEquals(u.costUsd, undefined);
});

Deno.test("extractUsage: codex sums usage across multiple turn.completed events", () => {
  const u = extractUsage("codex", CODEX_MULTITURN);
  // raw input 100+200=300, cached 10+20=30 → input field folds: 330
  assertEquals(u.input, 330);
  assertEquals(u.output, 13); // 5 + 8
  assertEquals(u.cacheRead, 30);
  assertEquals(u.reasoning, 5); // 2 + 3
  // total = rawInput(300) + output(13) + cacheRead(30). Reading only the first
  // turn would give input 110 / total 135 — this guards the multi-turn sum.
  assertEquals(u.total, 343);
  assertEquals(u.costUsd, undefined);
});

Deno.test("extractUsage: codex returns {} when no turn.completed event present", () => {
  assertEquals(extractUsage("codex", CODEX_TURN_FAILED), {});
  assertEquals(extractUsage("codex", "not json\n{}"), {});
});

Deno.test("extractUsage: returns empty object when no usage events present", () => {
  assertEquals(extractUsage("claude", "not json\n{}"), {});
  assertEquals(extractUsage("amp", "not json\n{}"), {});
  assertEquals(extractUsage("gemini", "not json"), {});
  assertEquals(extractUsage("opencode", "not json\n{}"), {});
  assertEquals(extractUsage("unknown", CLAUDE_OUTPUT), {});
});

// --- extractTextFromOutput --------------------------------------------------

Deno.test("extractTextFromOutput: amp reads result field from stream JSON", () => {
  assertEquals(extractTextFromOutput("amp", AMP_OUTPUT), "hi");
});

Deno.test("extractTextFromOutput: claude reads result field", () => {
  assertEquals(extractTextFromOutput("claude", CLAUDE_OUTPUT), "hi");
});

Deno.test("extractTextFromOutput: gemini reads response field", () => {
  assertEquals(extractTextFromOutput("gemini", GEMINI_OUTPUT), "hi");
});

Deno.test("extractTextFromOutput: codex reads the last agent_message text", () => {
  assertEquals(extractTextFromOutput("codex", CODEX_OUTPUT), "hi");
});

Deno.test("extractTextFromOutput: codex surfaces the error message when no agent_message", () => {
  const text = extractTextFromOutput("codex", CODEX_RATE_LIMIT);
  assertEquals(text.includes("Rate limit exceeded"), true);
  // Must be the human message, not the raw JSONL blob.
  assertEquals(text.startsWith("{"), false);
});

Deno.test("extractTextFromOutput: falls back to raw output when unparseable", () => {
  assertEquals(extractTextFromOutput("amp", "plain text"), "plain text");
  assertEquals(extractTextFromOutput("claude", "plain text"), "plain text");
  assertEquals(extractTextFromOutput("codex", "plain text"), "plain text");
});

// --- extractError -----------------------------------------------------------

// Real opencode capture (trimmed) when the GitHub Copilot monthly quota is
// exhausted: a single `type:"error"` event, no assistant text, exit 1.
const OPENCODE_QUOTA_ERROR = JSON.stringify({
  type: "error",
  timestamp: 1782327054427,
  sessionID: "ses_x",
  error: {
    name: "APIError",
    data: {
      message:
        'Payment Required: {"error":{"message":"You have exceeded your monthly quota","code":"quota_exceeded"}}',
      statusCode: 402,
      isRetryable: false,
      metadata: { url: "https://api.githubcopilot.com/v1/messages" },
    },
  },
});

Deno.test("extractError: opencode quota error is detected and fails fast (honors isRetryable:false)", () => {
  const err = extractError("opencode", OPENCODE_QUOTA_ERROR);
  assertEquals(err?.code, "402");
  // quota_exceeded reports isRetryable:false (monthly reset, retry-after days
  // away) — we honor that verbatim so it fails fast instead of burning backoff.
  assertEquals(err?.retryable, false);
  assertEquals(err?.message.includes("exceeded your monthly quota"), true);
});

Deno.test("extractError: opencode honors isRetryable:true for a genuine transient", () => {
  const transient = JSON.stringify({
    type: "error",
    error: {
      name: "APIError",
      data: {
        message: "Too Many Requests",
        statusCode: 429,
        isRetryable: true,
      },
    },
  });
  const err = extractError("opencode", transient);
  assertEquals(err?.retryable, true);
  assertEquals(err?.code, "429");
});

Deno.test("extractError: opencode returns null when output is a normal run", () => {
  assertEquals(extractError("opencode", OPENCODE_OUTPUT), null);
});

Deno.test("extractTextFromOutput: opencode surfaces the error message, not raw JSON", () => {
  const text = extractTextFromOutput("opencode", OPENCODE_QUOTA_ERROR);
  assertEquals(text.includes("exceeded your monthly quota"), true);
  // Must NOT be the raw JSON blob.
  assertEquals(text.startsWith("{"), false);
});

Deno.test("extractError: claude/amp detect is_error result events", () => {
  const claudeErr = JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "Overloaded: please retry",
  });
  const err = extractError("claude", claudeErr);
  assertEquals(err?.retryable, true); // "overloaded" hint
  assertEquals(err?.code, "error_during_execution");

  // A successful result must NOT be flagged as an error.
  assertEquals(extractError("claude", CLAUDE_OUTPUT), null);
  assertEquals(extractError("amp", AMP_OUTPUT), null);
});

Deno.test("extractError: gemini detects a top-level error field", () => {
  const geminiErr = JSON.stringify({
    error: { message: "Resource exhausted (429)", code: 429 },
  });
  const err = extractError("gemini", geminiErr);
  assertEquals(err?.code, "429");
  assertEquals(err?.retryable, true);
  assertEquals(extractError("gemini", GEMINI_OUTPUT), null);
});

Deno.test("extractError: codex unwraps a turn.failed nested-JSON message", () => {
  const err = extractError("codex", CODEX_TURN_FAILED);
  assertEquals(err?.code, "400");
  assertEquals(err?.message, "The model is not supported.");
  assertEquals(err?.retryable, false);
});

Deno.test("extractError: codex flags a top-level rate-limit error as retryable", () => {
  const err = extractError("codex", CODEX_RATE_LIMIT);
  assertEquals(err?.code, "429");
  assertEquals(err?.message, "Rate limit exceeded");
  assertEquals(err?.retryable, true);
});

Deno.test("extractError: codex ignores item.completed error notices and clean runs", () => {
  // A soft item.completed error notice on its own is not a turn failure.
  const softNotice = JSON.stringify({
    type: "item.completed",
    item: { type: "error", message: "fallback model metadata" },
  });
  assertEquals(extractError("codex", softNotice), null);
  // A clean run has no error.
  assertEquals(extractError("codex", CODEX_OUTPUT), null);
});

// --- Grok Build CLI ---------------------------------------------------------

// Real headless streaming-json capture (trivial "reply with hi" prompt).
const GROK_STREAM_OK = [
  JSON.stringify({ type: "thought", data: "The user wants only hi." }),
  JSON.stringify({ type: "text", data: "hi" }),
  JSON.stringify({
    type: "end",
    stopReason: "EndTurn",
    sessionId: "s_x",
    requestId: "r_x",
  }),
].join("\n");

// Multiple text chunks must concatenate.
const GROK_STREAM_MULTI_TEXT = [
  JSON.stringify({ type: "thought", data: "thinking" }),
  JSON.stringify({ type: "text", data: "hel" }),
  JSON.stringify({ type: "text", data: "lo" }),
  JSON.stringify({ type: "end", stopReason: "EndTurn" }),
].join("\n");

// Exact real capture for an invalid model id (Grok exits 0 with this on stdout).
const GROK_BAD_MODEL = JSON.stringify({
  type: "error",
  message:
    "Couldn't set model 'totally-invalid-model-xyz': Invalid params: \"unknown model id\". Run 'grok models' to see available models.",
});

// Combined stream: stderr plain Error line + stdout JSON error (real dual-channel shape).
const GROK_COMBINED_STDERR_PREFIX =
  `Error: Couldn't set model 'totally-invalid-model-xyz': Invalid params: "unknown model id". Run 'grok models' to see available models.\n${GROK_BAD_MODEL}`;

const GROK_RATE_LIMIT = JSON.stringify({
  type: "error",
  message: "Rate limit exceeded (429). Please retry later.",
});

// Real `grok models` stdout (trimmed to the listing section + noise headers).
const GROK_MODELS_STDOUT = `You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
`;

Deno.test("buildClaudeCommand: actor profile emits single equals-form --allowedTools arg, prompt trails", () => {
  const { cmd, stdin } = buildClaudeCommand(
    "claude",
    "opus",
    "Reply with only: hi",
    "actor",
  );
  assertEquals(cmd, [
    "claude",
    "--model",
    "opus",
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools=Read Grep Glob Edit Write Bash",
    "Reply with only: hi",
  ]);
  assertEquals(stdin, undefined);
  // The tools value must be a single argv entry (equals-form), not split into
  // two entries — `--allowedTools <tools...>` is variadic in claude v2.1.207
  // and would otherwise swallow the trailing prompt positional.
  assertEquals(cmd.includes("--allowedTools"), false);
  assertEquals(cmd[cmd.length - 1], "Reply with only: hi");
});

Deno.test("buildClaudeCommand: readonly profile scopes allowedTools, prompt still trails", () => {
  const { cmd } = buildClaudeCommand(
    "claude",
    "sonnet",
    "Reply with only: hi",
    "readonly",
  );
  assertEquals(cmd, [
    "claude",
    "--model",
    "sonnet",
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools=Read Grep Glob",
    "Reply with only: hi",
  ]);
  assertEquals(cmd.includes("--allowedTools"), false);
  assertEquals(cmd[cmd.length - 1], "Reply with only: hi");
});

Deno.test("buildGrokCommand: actor profile argv contract, no stdin, no --no-auto-update", () => {
  const { cmd, stdin } = buildGrokCommand(
    "grok",
    "grok-4.5",
    "Reply with only: hi",
    "actor",
  );
  assertEquals(cmd, [
    "grok",
    "-p",
    "Reply with only: hi",
    "-m",
    "grok-4.5",
    "--output-format",
    "streaming-json",
    "--sandbox",
    "workspace",
    "--permission-mode",
    "always-approve",
    "--deny",
    "Bash(git push*)",
    "--deny",
    "Bash(curl*)",
    "--deny",
    "Bash(rm -rf*)",
  ]);
  assertEquals(stdin, undefined);
  assertEquals(cmd.includes("--no-auto-update"), false);
  assertEquals(cmd.includes("--always-approve"), false);
  assertEquals(cmd.includes("bypassPermissions"), false);
});

Deno.test("buildGrokCommand: readonly profile scopes sandbox + denies unlisted tools", () => {
  const { cmd } = buildGrokCommand(
    "grok",
    "grok-4.5",
    "Reply with only: hi",
    "readonly",
  );
  assertEquals(cmd, [
    "grok",
    "-p",
    "Reply with only: hi",
    "-m",
    "grok-4.5",
    "--output-format",
    "streaming-json",
    "--sandbox",
    "read-only",
    "--permission-mode",
    "dontAsk",
  ]);
  assertEquals(cmd.includes("--always-approve"), false);
  assertEquals(cmd.includes("bypassPermissions"), false);
});

Deno.test("extractTextFromOutput: grok joins type:text data chunks, ignores thought", () => {
  assertEquals(extractTextFromOutput("grok", GROK_STREAM_OK), "hi");
  assertEquals(extractTextFromOutput("grok", GROK_STREAM_MULTI_TEXT), "hello");
});

Deno.test("extractTextFromOutput: grok surfaces error message when no text", () => {
  const text = extractTextFromOutput("grok", GROK_BAD_MODEL);
  assertEquals(text.includes("unknown model id"), true);
  assertEquals(text.startsWith("{"), false);
});

Deno.test("extractError: grok real bad-model capture is non-retryable", () => {
  const err = extractError("grok", GROK_BAD_MODEL);
  assertEquals(err !== null, true);
  assertEquals(err?.retryable, false);
  assertEquals(err?.message.includes("unknown model id"), true);
});

Deno.test("extractError: grok finds error after stderr Error: prefix (combined stream)", () => {
  const err = extractError("grok", GROK_COMBINED_STDERR_PREFIX);
  assertEquals(err !== null, true);
  assertEquals(err?.retryable, false);
  assertEquals(err?.message.includes("unknown model id"), true);
});

// Stderr-only exit-0 failure (no JSON on stdout) must still be detected.
const GROK_STDERR_ONLY =
  `Error: Couldn't set model 'totally-invalid-model-xyz': Invalid params: "unknown model id". Run 'grok models' to see available models.`;

Deno.test("extractError: grok detects plain Error: line with no JSON (stderr-only)", () => {
  const err = extractError("grok", GROK_STDERR_ONLY);
  assertEquals(err !== null, true);
  assertEquals(err?.retryable, false);
  assertEquals(err?.message.includes("unknown model id"), true);
  // Message is the body after "Error: ", not the raw prefix alone.
  assertEquals(err?.message.startsWith("Error:"), false);
});

Deno.test("extractTextFromOutput: grok surfaces plain Error: when no text chunks", () => {
  const text = extractTextFromOutput("grok", GROK_STDERR_ONLY);
  assertEquals(text.includes("unknown model id"), true);
});

Deno.test("extractError: grok rate-limit message is retryable", () => {
  const err = extractError("grok", GROK_RATE_LIMIT);
  assertEquals(err?.retryable, true);
  assertEquals(err?.message.includes("Rate limit"), true);
});

Deno.test("extractError: grok clean stream is not an error", () => {
  assertEquals(extractError("grok", GROK_STREAM_OK), null);
});

// A successful run whose stderr carries benign noise matching `Error: …`
// (update checks, telemetry) must NOT be reported as a provider failure —
// the plain-text fallback only applies when the run produced no text chunks.
const GROK_STREAM_OK_WITH_STDERR_NOISE =
  `${GROK_STREAM_OK}\nError: failed to check for updates: connect ETIMEDOUT`;

Deno.test("extractError: grok ignores stderr Error: noise when text chunks exist", () => {
  assertEquals(extractError("grok", GROK_STREAM_OK_WITH_STDERR_NOISE), null);
  assertEquals(
    extractTextFromOutput("grok", GROK_STREAM_OK_WITH_STDERR_NOISE),
    "hi",
  );
});

Deno.test("extractError: grok JSON type:error wins even alongside text chunks", () => {
  // Structured errors are authoritative regardless of extracted text.
  const combined = `${GROK_STREAM_OK}\n${GROK_BAD_MODEL}`;
  const err = extractError("grok", combined);
  assertEquals(err !== null, true);
  assertEquals(err?.message.includes("unknown model id"), true);
});

Deno.test("extractUsage: grok returns empty (no tokens/cost on headless stdout)", () => {
  assertEquals(extractUsage("grok", GROK_STREAM_OK), {});
  assertEquals(extractUsage("grok", GROK_BAD_MODEL), {});
});

Deno.test("parseGrokModelsList: strips bullets, (default), headers, blanks, unicode bullet", () => {
  assertEquals(parseGrokModelsList(GROK_MODELS_STDOUT), [
    "grok-4.5",
    "grok-composer-2.5-fast",
  ]);
  assertEquals(parseGrokModelsList(""), []);
  assertEquals(parseGrokModelsList("Available models:\n"), []);
  assertEquals(
    parseGrokModelsList("Available models:\n  • grok-4.5 (default)\n"),
    ["grok-4.5"],
  );
});

// --- Provider registry / model resolution -----------------------------------

Deno.test("ModelIdSchema: trims; rejects empty and whitespace-only", () => {
  assertEquals(ModelIdSchema.parse("  opus  "), "opus");
  assertEquals(ModelIdSchema.parse("grok-4.5"), "grok-4.5");
  assertThrows(() => ModelIdSchema.parse(""));
  assertThrows(() => ModelIdSchema.parse("   "));
  assertThrows(() => ModelIdSchema.parse("\n\t"));
});

Deno.test("resolveModel: explicit, configured global, and unconfigured-opus→provider default", () => {
  // Explicit always wins (after trim).
  assertEquals(resolveModel("grok", "custom-id", "opus"), "custom-id");
  assertEquals(resolveModel("grok", "  custom-id  ", "opus"), "custom-id");
  assertEquals(resolveModel("claude", "sonnet", "opus"), "sonnet");
  // Configured global default wins: user set defaultModel=sonnet.
  assertEquals(resolveModel("claude", undefined, "sonnet"), "sonnet");
  // Configured Grok model wins over registry default.
  assertEquals(resolveModel("grok", undefined, "grok-4.6"), "grok-4.6");
  // Unconfigured Claude schema default + non-Claude provider → provider default.
  assertEquals(resolveModel("grok", undefined, "opus"), "grok-4.5");
  // Blank / whitespace explicit is treated as omitted (not a model id).
  assertEquals(resolveModel("grok", "", "opus"), "grok-4.5");
  assertEquals(resolveModel("grok", "   ", "opus"), "grok-4.5");
  // Claude with schema default stays opus.
  assertEquals(resolveModel("claude", undefined, "opus"), "opus");
  // Provider without registry default uses global as-is.
  assertEquals(resolveModel("codex", undefined, "gpt-5.5"), "gpt-5.5");
});

Deno.test("PROVIDERS registry: capabilities closed; extractors and listModels on adapters", () => {
  const keys = Object.keys(PROVIDERS).sort();
  assertEquals(keys, [
    "amp",
    "claude",
    "codex",
    "gemini",
    "grok",
    "opencode",
  ]);
  assertEquals(PROVIDERS.grok.combineStreams, true);
  assertEquals(PROVIDERS.claude.combineStreams, false);
  assertEquals(typeof PROVIDERS.grok.parseModelsList, "function");
  assertEquals(typeof PROVIDERS.opencode.parseModelsList, "function");
  assertEquals(PROVIDERS.claude.parseModelsList, undefined);
  assertEquals(PROVIDERS.grok.defaultModel, "grok-4.5");
  // Adapter extractors match free functions.
  assertEquals(
    PROVIDERS.grok.extractText(GROK_STREAM_OK),
    extractTextFromOutput("grok", GROK_STREAM_OK),
  );
  assertEquals(
    PROVIDERS.grok.extractError(GROK_BAD_MODEL)?.message,
    extractError("grok", GROK_BAD_MODEL)?.message,
  );
  assertEquals(isProvider("grok"), true);
  assertEquals(isProvider("not-a-provider"), false);
});

Deno.test("listProvidersFromRegistry: closed catalog with listModels capability flags", () => {
  const listed = listProvidersFromRegistry();
  assertEquals(
    listed.map((p) => p.id),
    ["amp", "claude", "codex", "gemini", "grok", "opencode"],
  );
  assertEquals(listed.length, Object.keys(PROVIDERS).length);

  const byId = Object.fromEntries(listed.map((p) => [p.id, p]));
  assertEquals(byId.claude.defaultModel, "opus");
  assertEquals(byId.claude.supportsListModels, false);
  assertEquals(byId.grok.defaultModel, "grok-4.5");
  assertEquals(byId.grok.supportsListModels, true);
  assertEquals(byId.opencode.supportsListModels, true);
  assertEquals(byId.opencode.defaultModel, undefined);
  assertEquals(byId.codex.supportsListModels, false);
  assertEquals(byId.codex.defaultModel, undefined);
});

// --- wrapWithSandbox (Seatbelt sandbox wrap point) --------------------------

Deno.test("wrapWithSandbox: mode 'off' returns cmd unchanged", () => {
  const cmd = ["claude", "--print", "hi"];
  const out = wrapWithSandbox(cmd, "/tmp/wd", {
    mode: "off",
    profilePath: "/some/profile.sb",
    required: false,
  });
  assertEquals(out, cmd);
});

Deno.test("wrapWithSandbox: mode 'seatbelt' + sandbox-exec available produces the correct argv (this machine is Darwin with real sandbox-exec)", () => {
  const cmd = ["claude", "--print", "hi"];
  const out = wrapWithSandbox(cmd, "/tmp/wd", {
    mode: "seatbelt",
    profilePath: "/path/to/cli_agent.sandbox.sb",
    required: false,
  });
  assertEquals(out, [
    "/usr/bin/sandbox-exec",
    "-f",
    "/path/to/cli_agent.sandbox.sb",
    "-D",
    "CWD=/tmp/wd",
    "-D",
    `HOME=${Deno.env.get("HOME") ?? ""}`,
    "claude",
    "--print",
    "hi",
  ]);
});

Deno.test("wrapWithSandbox: cwd defaults to Deno.cwd() when omitted", () => {
  const cmd = ["claude"];
  const out = wrapWithSandbox(cmd, undefined, {
    mode: "seatbelt",
    profilePath: "/profile.sb",
    required: false,
  });
  assertEquals(out[4], `CWD=${Deno.cwd()}`);
});

Deno.test("wrapWithSandbox: unavailable sandbox-exec + not required degrades to unsandboxed cmd and warns", () => {
  const cmd = ["claude", "--print", "hi"];
  let warned = false;
  let warnedReason: unknown;
  const logger = {
    info: () => {},
    warning: (_msg: string, props?: Record<string, unknown>) => {
      warned = true;
      warnedReason = props?.reason;
    },
    error: () => {},
  };
  const out = wrapWithSandbox(
    cmd,
    "/tmp/wd",
    { mode: "seatbelt", profilePath: "/profile.sb", required: false },
    logger,
    "/nonexistent/sandbox-exec",
  );
  assertEquals(out, cmd);
  assertEquals(warned, true);
  assertEquals(
    String(warnedReason).includes("/nonexistent/sandbox-exec"),
    true,
  );
});

Deno.test("wrapWithSandbox: unavailable sandbox-exec + sandboxRequired throws instead of degrading", () => {
  const cmd = ["claude", "--print", "hi"];
  assertThrows(
    () =>
      wrapWithSandbox(
        cmd,
        "/tmp/wd",
        { mode: "seatbelt", profilePath: "/profile.sb", required: true },
        undefined,
        "/nonexistent/sandbox-exec",
      ),
    Error,
    "sandboxRequired is true",
  );
});

// --- sandboxConfigFrom (default profile resolution) -------------------------
//
// Regression guard for the ship-time bug where the default profile was resolved
// via `new URL("./cli_agent.sandbox.sb", import.meta.url)` (i.e. next to the
// model .ts). The `.sb` ships through the manifest `binaries` field, which lands
// it in the extension's files root — `<ext>/files/` when pulled, NOT `models/`.
// So the URL-relative resolution pointed at a nonexistent path once pulled and
// the sandbox silently failed to load. The fix resolves the default lazily via
// `ctx.extensionFile(SANDBOX_PROFILE_FILENAME)`, which is layout-agnostic.

/**
 * Build a tmp dir mimicking the PULLED extension layout:
 *   <root>/models/cli_agent.ts        (the model)
 *   <root>/files/cli_agent.sandbox.sb (the binary, where swamp actually ships it)
 * Returns the files-root dir (what `ctx.extensionFile` closes over when pulled)
 * and the absolute .sb path inside it.
 */
function makePulledLayout(): { filesRoot: string; sbPath: string } {
  const root = Deno.makeTempDirSync({ prefix: "cli_agent_pulled_" });
  Deno.mkdirSync(`${root}/models`);
  Deno.mkdirSync(`${root}/files`);
  Deno.writeTextFileSync(`${root}/models/cli_agent.ts`, "// pulled model\n");
  const sbPath = `${root}/files/${SANDBOX_PROFILE_FILENAME}`;
  Deno.writeTextFileSync(sbPath, "(version 1)(allow default)\n");
  return { filesRoot: `${root}/files`, sbPath };
}

Deno.test("sandboxConfigFrom: seatbelt resolves the default profile from the pulled files/ dir (existing file)", () => {
  const { filesRoot, sbPath } = makePulledLayout();
  // Faithful stand-in for swamp's ctx.extensionFile: join relPath onto the
  // files root (the pulled `files/` dir) and confirm it exists on disk.
  const extensionFile = (relPath: string): string => {
    const abs = `${filesRoot}/${relPath}`;
    Deno.lstatSync(abs); // throws if missing — same contract as the runtime
    return abs;
  };

  const g = GlobalArgsSchema.parse({});
  const cfg = sandboxConfigFrom(
    g,
    () => extensionFile(SANDBOX_PROFILE_FILENAME),
    { sandboxMode: "seatbelt" },
  );

  assertEquals(cfg.mode, "seatbelt");
  assertEquals(cfg.profilePath, sbPath);
  // The resolved path must point at a file that actually exists — the whole
  // point of the bug fix.
  assertEquals(Deno.lstatSync(cfg.profilePath).isFile, true);
});

Deno.test("sandboxConfigFrom: off (default) never invokes the resolver", () => {
  let called = false;
  const g = GlobalArgsSchema.parse({}); // sandboxMode defaults to "off"
  const cfg = sandboxConfigFrom(g, () => {
    called = true;
    return "/should/not/be/reached.sb";
  });

  assertEquals(cfg.mode, "off");
  assertEquals(called, false); // lazy: no filesystem touch on the off path
});

Deno.test("sandboxConfigFrom: explicit sandboxProfile override wins and skips the resolver", () => {
  let called = false;
  const g = GlobalArgsSchema.parse({ sandboxProfile: "/custom/profile.sb" });
  const cfg = sandboxConfigFrom(
    g,
    () => {
      called = true;
      return "/default/should/not/be/used.sb";
    },
    { sandboxMode: "seatbelt" },
  );

  assertEquals(cfg.profilePath, "/custom/profile.sb");
  assertEquals(called, false);
});
