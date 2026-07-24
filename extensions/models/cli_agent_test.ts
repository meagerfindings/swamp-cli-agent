/**
 * Unit tests for the provider-specific usage and text extractors.
 *
 * The JSONL/JSON fixtures below are real captures from each CLI run against a
 * trivial "reply with hi" prompt, trimmed to the fields the extractors read.
 * They are the ground truth for the per-provider parsing in `cli_agent.ts`.
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildBwrapArgs,
  buildClaudeCommand,
  buildGrokCommand,
  buildPiCommand,
  classifyFailure,
  extractError,
  extractTextFromOutput,
  extractUsage,
  filterProviderChildEnv,
  GlobalArgsSchema,
  InvocationSchema,
  isProvider,
  listProvidersFromRegistry,
  ModelIdSchema,
  parseGrokModelsList,
  PROVIDER_CHILD_ENV_DENYLIST,
  PROVIDERS,
  resolveEffectiveBackend,
  resolveModel,
  runCli,
  SANDBOX_PROFILE_FILENAME,
  SANDBOX_STRICT_PROFILE_FILENAME,
  sandboxConfigFrom,
  SIGNATURE_TABLE,
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

Deno.test("filterProviderChildEnv: removes only Swamp control-plane credentials without mutating input", () => {
  assertEquals(PROVIDER_CHILD_ENV_DENYLIST, [
    "SWAMP_WORKER_TOKEN",
    "SWAMP_SERVER_TOKEN",
    "SWAMP_API_KEY",
    "SWAMP_SERVE_EXTRA_HEADERS",
  ]);

  const env = {
    SWAMP_WORKER_TOKEN: "worker-secret",
    SWAMP_SERVER_TOKEN: "server-secret",
    SWAMP_API_KEY: "api-secret",
    SWAMP_SERVE_EXTRA_HEADERS: "Authorization: secret",
    SWAMP_REPO_DIR: "/repo",
    SWAMP_ORCHESTRATOR_URL: "https://orchestrator.example",
    SWAMP_SERVER_URL: "https://server.example",
    SWAMP_SERVE_URL: "https://serve.example",
    SWAMP_CLUB_URL: "https://club.example",
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/agent",
    ANTHROPIC_API_KEY: "anthropic-secret",
    OPENAI_API_KEY: "openai-secret",
  };
  const original = { ...env };

  assertEquals(filterProviderChildEnv(env), {
    SWAMP_REPO_DIR: "/repo",
    SWAMP_ORCHESTRATOR_URL: "https://orchestrator.example",
    SWAMP_SERVER_URL: "https://server.example",
    SWAMP_SERVE_URL: "https://serve.example",
    SWAMP_CLUB_URL: "https://club.example",
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/agent",
    ANTHROPIC_API_KEY: "anthropic-secret",
    OPENAI_API_KEY: "openai-secret",
  });
  assertEquals(env, original);
});

// FRK-SEC-001 (Medium): `filterProviderChildEnv` used to be a four-literal
// denylist over the full environment, which fails OPEN for any future
// `SWAMP_*` credential var Swamp introduces — it would reach provider
// subprocesses by default until someone remembered to add it to the list.
// It is now a deny-by-`SWAMP_`-prefix strip with a fixed non-secret
// re-allow list, which fails CLOSED instead: this test proves an entirely
// unknown, made-up `SWAMP_*` var (not in the four-literal list, not in the
// non-secret re-allow list, not seen anywhere in this codebase) is stripped
// anyway, purely because of its prefix. This assertion only passes under
// the prefix design — a literal denylist would let it through unchanged.
Deno.test("filterProviderChildEnv: strips an unknown future SWAMP_* var by prefix, not just the four known literals", () => {
  const env = {
    SWAMP_SECRET_X: "some-future-credential-nobody-added-to-a-list-yet",
    SWAMP_REPO_DIR: "/repo",
    ANTHROPIC_API_KEY: "anthropic-secret",
  };

  const filtered = filterProviderChildEnv(env);

  assertEquals("SWAMP_SECRET_X" in filtered, false);
  assertEquals(filtered, {
    SWAMP_REPO_DIR: "/repo",
    ANTHROPIC_API_KEY: "anthropic-secret",
  });
});

Deno.test("runCli: spawned child omits control-plane credentials and preserves provider config", async () => {
  const names = [...PROVIDER_CHILD_ENV_DENYLIST, "XAI_API_KEY"];
  const previous = Object.fromEntries(
    names.map((name) => [name, Deno.env.get(name)]),
  );

  try {
    for (const name of PROVIDER_CHILD_ENV_DENYLIST) {
      Deno.env.set(name, "test-secret");
    }
    Deno.env.set("XAI_API_KEY", "test-provider-config");

    const result = await runCli(
      [
        Deno.execPath(),
        "eval",
        `const names = ${
          JSON.stringify(names)
        }; console.log(JSON.stringify(Object.fromEntries(names.map((name) => [name, Deno.env.has(name)]))))`,
      ],
      { wallTimeoutMs: 10_000 },
    );

    assertEquals(result.success, true);
    assertEquals(JSON.parse(result.stdout), {
      SWAMP_WORKER_TOKEN: false,
      SWAMP_SERVER_TOKEN: false,
      SWAMP_API_KEY: false,
      SWAMP_SERVE_EXTRA_HEADERS: false,
      XAI_API_KEY: true,
    });
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

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
    "pi",
  ]);
  assertEquals(PROVIDERS.grok.combineStreams, true);
  assertEquals(PROVIDERS.claude.combineStreams, false);
  assertEquals(PROVIDERS.pi.combineStreams, true);
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
    ["amp", "claude", "codex", "gemini", "grok", "opencode", "pi"],
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
  // pi: no registry defaultModel (pi instance config must set defaultModel)
  // and no listModels support (pi enumerates via --list-models, not a
  // `models` subcommand, so parseModelsList is intentionally absent).
  assertEquals(byId.pi.supportsListModels, false);
  assertEquals(byId.pi.defaultModel, undefined);
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
    (fn) => extensionFile(fn),
    { sandboxMode: "seatbelt" },
  );

  assertEquals(cfg.mode, "seatbelt");
  assertEquals(cfg.profilePath, sbPath);
  // The resolved path must point at a file that actually exists — the whole
  // point of the bug fix.
  assertEquals(Deno.lstatSync(cfg.profilePath).isFile, true);
});

Deno.test("sandboxConfigFrom: explicit off never invokes the resolver", () => {
  let called = false;
  const g = GlobalArgsSchema.parse({ sandboxMode: "off" });
  const cfg = sandboxConfigFrom(g, () => {
    called = true;
    return "/should/not/be/reached.sb";
  });

  assertEquals(cfg.mode, "off");
  assertEquals(called, false); // lazy: no filesystem touch on the off path
});

Deno.test("sandboxConfigFrom: auto (default) on this Darwin test machine resolves the seatbelt profile", () => {
  // GlobalArgsSchema now defaults sandboxMode to "auto", and this suite runs
  // on a real Darwin machine, so the effective backend is seatbelt and the
  // profile resolver IS invoked (mirrors the seatbelt-explicit test above,
  // but exercises the new default instead of an explicit override).
  let called = false;
  const g = GlobalArgsSchema.parse({}); // sandboxMode defaults to "auto"
  const cfg = sandboxConfigFrom(g, () => {
    called = true;
    return "/resolved/default.sb";
  });

  assertEquals(cfg.mode, "auto");
  assertEquals(called, true);
  assertEquals(cfg.profilePath, "/resolved/default.sb");
});

Deno.test("sandboxConfigFrom: bwrap mode never invokes the seatbelt profile resolver", () => {
  let called = false;
  const g = GlobalArgsSchema.parse({ sandboxMode: "bwrap" });
  const cfg = sandboxConfigFrom(g, () => {
    called = true;
    return "/should/not/be/reached.sb";
  });

  assertEquals(cfg.mode, "bwrap");
  assertEquals(called, false);
  assertEquals(cfg.profilePath, "");
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

// --- sandboxConfigFrom + sandboxNetwork (opt-in hardened profile selection) --
//
// Regression guard for the opt-in strict-network-deny sandbox mode: the
// DEFAULT (`sandboxNetwork: "allow"`, whether via global default or omitted
// per-call override) must resolve the exact same base filename as before this
// arg existed — every existing consumer (ADW, software-factory) is unaffected.
// Only an explicit "deny" resolves the strict filename, and only when seatbelt
// is the effective backend; the resolver is otherwise never invoked (lazy).

Deno.test("sandboxConfigFrom: sandboxNetwork defaults to 'allow' on GlobalArgsSchema", () => {
  const g = GlobalArgsSchema.parse({});
  assertEquals(g.sandboxNetwork, "allow");
});

Deno.test("sandboxConfigFrom: sandboxNetwork 'allow' (default) resolves the BASE filename, not strict", () => {
  let resolvedFilename: string | undefined;
  const g = GlobalArgsSchema.parse({}); // sandboxNetwork defaults to "allow"
  const cfg = sandboxConfigFrom(
    g,
    (fn) => {
      resolvedFilename = fn;
      return `/resolved/${fn}`;
    },
    { sandboxMode: "seatbelt" },
  );

  assertEquals(resolvedFilename, SANDBOX_PROFILE_FILENAME);
  assertEquals(cfg.profilePath, `/resolved/${SANDBOX_PROFILE_FILENAME}`);
});

Deno.test("sandboxConfigFrom: sandboxNetwork 'deny' resolves the STRICT filename", () => {
  let resolvedFilename: string | undefined;
  const g = GlobalArgsSchema.parse({});
  const cfg = sandboxConfigFrom(
    g,
    (fn) => {
      resolvedFilename = fn;
      return `/resolved/${fn}`;
    },
    { sandboxMode: "seatbelt", sandboxNetwork: "deny" },
  );

  assertEquals(resolvedFilename, SANDBOX_STRICT_PROFILE_FILENAME);
  assertEquals(cfg.profilePath, `/resolved/${SANDBOX_STRICT_PROFILE_FILENAME}`);
});

Deno.test("sandboxConfigFrom: global sandboxNetwork 'deny' (no per-call override) also resolves the STRICT filename", () => {
  // Exercises the g.sandboxNetwork fallback path (overrides?.sandboxNetwork is
  // undefined), mirroring how a downstream model could set its OWN global
  // default to "deny" for an untrusted-input-only instance.
  let resolvedFilename: string | undefined;
  const g = GlobalArgsSchema.parse({ sandboxNetwork: "deny" });
  const cfg = sandboxConfigFrom(
    g,
    (fn) => {
      resolvedFilename = fn;
      return `/resolved/${fn}`;
    },
    { sandboxMode: "seatbelt" },
  );

  assertEquals(resolvedFilename, SANDBOX_STRICT_PROFILE_FILENAME);
  assertEquals(cfg.profilePath, `/resolved/${SANDBOX_STRICT_PROFILE_FILENAME}`);
});

Deno.test("sandboxConfigFrom: explicit sandboxProfile override wins over sandboxNetwork:'deny' too", () => {
  let called = false;
  const g = GlobalArgsSchema.parse({ sandboxProfile: "/custom/profile.sb" });
  const cfg = sandboxConfigFrom(
    g,
    () => {
      called = true;
      return "/default/should/not/be/used.sb";
    },
    { sandboxMode: "seatbelt", sandboxNetwork: "deny" },
  );

  assertEquals(cfg.profilePath, "/custom/profile.sb");
  assertEquals(called, false);
});

Deno.test("sandboxConfigFrom: sandboxNetwork:'deny' with backend NOT seatbelt (mode 'off') never invokes the resolver", () => {
  let called = false;
  const g = GlobalArgsSchema.parse({ sandboxMode: "off" });
  const cfg = sandboxConfigFrom(
    g,
    () => {
      called = true;
      return "/should/not/be/reached.sb";
    },
    { sandboxNetwork: "deny" },
  );

  assertEquals(cfg.mode, "off");
  assertEquals(called, false);
  assertEquals(cfg.profilePath, "");
});

Deno.test("sandboxConfigFrom: sandboxNetwork:'deny' with backend bwrap never invokes the (seatbelt-only) resolver", () => {
  let called = false;
  const g = GlobalArgsSchema.parse({ sandboxMode: "bwrap" });
  const cfg = sandboxConfigFrom(
    g,
    () => {
      called = true;
      return "/should/not/be/reached.sb";
    },
    { sandboxNetwork: "deny" },
  );

  assertEquals(cfg.mode, "bwrap");
  assertEquals(called, false);
  assertEquals(cfg.profilePath, "");
});

// --- resolveEffectiveBackend (pure mode+OS → backend resolution) ------------
//
// Extracted out of wrapWithSandbox specifically so the OS-dispatch DECISION
// is unit-testable for every mode/OS combination without mocking
// `Deno.build.os` (read-only) or the filesystem — wrapWithSandbox still owns
// checking whether the resolved backend's binary actually exists.

Deno.test("resolveEffectiveBackend: auto + darwin -> seatbelt", () => {
  assertEquals(resolveEffectiveBackend("auto", "darwin"), "seatbelt");
});

Deno.test("resolveEffectiveBackend: auto + linux -> bwrap", () => {
  assertEquals(resolveEffectiveBackend("auto", "linux"), "bwrap");
});

Deno.test("resolveEffectiveBackend: auto + windows (unsupported OS) -> none", () => {
  assertEquals(resolveEffectiveBackend("auto", "windows"), "none");
});

Deno.test("resolveEffectiveBackend: off + any OS -> none", () => {
  assertEquals(resolveEffectiveBackend("off", "darwin"), "none");
  assertEquals(resolveEffectiveBackend("off", "linux"), "none");
  assertEquals(resolveEffectiveBackend("off", "windows"), "none");
});

Deno.test("resolveEffectiveBackend: seatbelt + linux -> seatbelt (forced; will degrade in wrapWithSandbox)", () => {
  assertEquals(resolveEffectiveBackend("seatbelt", "linux"), "seatbelt");
});

Deno.test("resolveEffectiveBackend: bwrap + darwin -> bwrap (forced; will degrade in wrapWithSandbox)", () => {
  assertEquals(resolveEffectiveBackend("bwrap", "darwin"), "bwrap");
});

Deno.test("resolveEffectiveBackend: seatbelt + darwin -> seatbelt (forced, matches OS)", () => {
  assertEquals(resolveEffectiveBackend("seatbelt", "darwin"), "seatbelt");
});

Deno.test("resolveEffectiveBackend: bwrap + linux -> bwrap (forced, matches OS)", () => {
  assertEquals(resolveEffectiveBackend("bwrap", "linux"), "bwrap");
});

// --- wrapWithSandbox: mode "auto" ---------------------------------------------
//
// This suite runs on a real Darwin machine, so "auto" resolves to seatbelt
// here and produces the exact same argv as an explicit `mode: "seatbelt"`
// config. The Linux side of "auto" (resolves to bwrap) is proved by
// `resolveEffectiveBackend: auto + linux -> bwrap` above plus the existing
// `buildBwrapArgs`/roccinante-proven argv tests — `Deno.build.os` cannot be
// forced to "linux" in-process (read-only property), so the full dispatch
// through `wrapWithSandbox` for the Linux branch is exercised on roccinante,
// not in this suite (see the "Linux bwrap dispatch" comment block below).

Deno.test("wrapWithSandbox: mode 'auto' on darwin resolves to seatbelt and produces the sandbox-exec argv", () => {
  const cmd = ["claude", "--print", "hi"];
  const out = wrapWithSandbox(cmd, "/tmp/wd", {
    mode: "auto",
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

Deno.test("wrapWithSandbox: mode 'bwrap' forced on darwin (OS mismatch) degrades and warns", () => {
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
    { mode: "bwrap", profilePath: "", required: false },
    logger,
  );
  assertEquals(out, cmd);
  assertEquals(warned, true);
  assertEquals(String(warnedReason).includes("not linux"), true);
});

Deno.test("wrapWithSandbox: mode 'bwrap' forced on darwin + sandboxRequired throws", () => {
  const cmd = ["claude", "--print", "hi"];
  assertThrows(
    () =>
      wrapWithSandbox(cmd, "/tmp/wd", {
        mode: "bwrap",
        profilePath: "",
        required: true,
      }),
    Error,
    "sandboxRequired is true",
  );
});

// --- Seatbelt profile content: Swamp control-plane credential deny (FRK-SEC-001) ---
//
// The tests above exercise `wrapWithSandbox`'s ARGV construction (it just
// passes `-f <profilePath>` through) but never parse the actual shipped
// `.sb` file's contents. FRK-SEC-001 found that `~/.config/swamp/auth.json`
// (the Swamp control-plane API key persisted by `swamp auth login`) was
// missing from the profile's read-deny and write-deny sets, so a sandboxed
// provider CLI could read it directly off disk even though
// `PROVIDER_CHILD_ENV_DENYLIST` already strips the equivalent
// `SWAMP_API_KEY` env var. This test reads the real source `.sb` file
// (sibling of this test file in the source tree, same layout the doc
// comment on SANDBOX_PROFILE_FILENAME describes) and asserts the fix is
// present as a regression guard against it silently regressing.
Deno.test("cli_agent.sandbox.sb: denies read and write of ~/.config/swamp (Swamp control-plane credentials)", async () => {
  const sbPath = new URL("./cli_agent.sandbox.sb", import.meta.url);
  const profile = await Deno.readTextFile(sbPath);

  // Read-deny: must appear inside the `(deny file-read* ...)` block.
  assertEquals(
    profile.includes('(subpath (string-append HOME "/.config/swamp"))'),
    true,
    'expected a (subpath ... "/.config/swamp") entry (read or write deny) in cli_agent.sandbox.sb',
  );

  // There must be at least two occurrences: one under file-read* and one
  // under file-write* — a single shared entry would not prove both classes
  // are covered, since Seatbelt rules are scoped per operation class.
  const denySubpathCount = profile.split(
    '(subpath (string-append HOME "/.config/swamp"))',
  ).length - 1;
  assertEquals(
    denySubpathCount >= 2,
    true,
    "expected ~/.config/swamp to be denied under BOTH file-read* and file-write*, " +
      `found ${denySubpathCount} occurrence(s)`,
  );

  // Sanity: the new deny must be reachable from a `(deny file-write* ...)`
  // form somewhere in the file, not just read-deny.
  const writeDenyIdx = profile.indexOf("(deny file-write*");
  const configSwampAfterWriteDeny = profile.indexOf(
    "/.config/swamp",
    writeDenyIdx,
  );
  assertEquals(
    writeDenyIdx !== -1 && configSwampAfterWriteDeny !== -1,
    true,
    "expected /.config/swamp to appear after a (deny file-write* ...) form",
  );
});

// --- buildBwrapArgs (Linux bwrap sandbox backend) ---------------------------
//
// Pure argv builder — see the doc comment on buildBwrapArgs in cli_agent.ts
// for the full policy rationale and the roccinante proof this mirrors.

Deno.test("buildBwrapArgs: includes the cwd bind, namespaces, network NOT unshared", () => {
  const exists = () => false; // no home-relative dirs exist in this fixture
  const argv = buildBwrapArgs(
    ["claude", "--print", "hi"],
    "/work/dir",
    "/home/agent",
    exists,
  );

  // cwd is bound read-write for both source and dest.
  const cwdBindIdx = argv.indexOf("--bind");
  assertEquals(argv[cwdBindIdx + 1], "/work/dir");
  assertEquals(argv[cwdBindIdx + 2], "/work/dir");

  // Required namespace/lifecycle flags present.
  for (
    const flag of [
      "--unshare-user",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--new-session",
    ]
  ) {
    assertEquals(argv.includes(flag), true, `expected ${flag} in argv`);
  }

  // Network is deliberately NOT unshared (egress allowed, matches Seatbelt).
  assertEquals(argv.includes("--unshare-net"), false);

  // The real cmd trails, unmodified, as the final argv elements.
  assertEquals(argv.slice(-3), ["claude", "--print", "hi"]);
});

Deno.test("buildBwrapArgs: excludes secret dirs entirely (no bind emitted) even when they exist on disk", () => {
  // Simulate a box where secret dirs DO exist — the function must never bind
  // them regardless, since they are not in STATE_DIRS/CREDENTIAL_FILES.
  const exists = () => true;
  const argv = buildBwrapArgs(["echo", "hi"], "/work", "/home/agent", exists);

  for (
    const secret of [
      "/home/agent/.ssh",
      "/home/agent/.aws",
      "/home/agent/.config/gcloud",
      "/home/agent/.config/gh",
      "/home/agent/.gnupg",
      "/home/agent/.config/op",
      "/home/agent/.docker",
      "/home/agent/.gemini",
      "/home/agent/.npmrc",
    ]
  ) {
    assertEquals(
      argv.includes(secret),
      false,
      `${secret} must never appear in bwrap argv`,
    );
  }
});

Deno.test("buildBwrapArgs: binds existing state dirs writable and masks existing credential files with /dev/null", () => {
  const existing = new Set([
    "/home/agent/.claude",
    "/home/agent/.claude/.credentials.json",
    "/home/agent/.cache",
  ]);
  const exists = (p: string) => existing.has(p);
  const argv = buildBwrapArgs(["echo", "hi"], "/work", "/home/agent", exists);

  // .claude is bound read-write (state dir).
  const claudeIdx = argv.indexOf("/home/agent/.claude");
  assertEquals(argv[claudeIdx - 1], "--bind");
  assertEquals(argv[claudeIdx + 1], "/home/agent/.claude");

  // The credential file is masked with a read-only /dev/null bind — this
  // denies BOTH read (process sees empty /dev/null) and write (ro-bind is
  // immutable) while .claude itself stays writable for non-credential state.
  const credIdx = argv.indexOf("/home/agent/.claude/.credentials.json");
  assertEquals(argv[credIdx - 2], "--ro-bind");
  assertEquals(argv[credIdx - 1], "/dev/null");

  // .cache is bound (state dir), .codex is absent so no bind for it at all.
  assertEquals(argv.includes("/home/agent/.cache"), true);
  assertEquals(argv.includes("/home/agent/.codex"), false);
});

Deno.test("buildBwrapArgs: binds ~/.pi writable (pi's config/auth lives there — no credential masking)", () => {
  const existing = new Set(["/home/agent/.pi"]);
  const exists = (p: string) => existing.has(p);
  const argv = buildBwrapArgs(["echo", "hi"], "/work", "/home/agent", exists);
  const idx = argv.indexOf("/home/agent/.pi");
  assertEquals(argv[idx - 1], "--bind");
});

// --- pi provider ------------------------------------------------------------

// pi `--print --mode json` JSONL: text lives on the assistant message's
// content array (interleaved with `thinking` parts that must be excluded);
// usage + cost live on the same message's `usage` object. Trimmed from a real
// capture against openrouter/moonshotai/kimi-k3.
const PI_STREAM_OK = [
  JSON.stringify({ type: "session", version: 3, id: "s1" }),
  JSON.stringify({ type: "agent_start" }),
  JSON.stringify({ type: "turn_start" }),
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning here" },
        { type: "text", text: '{"ok": true}' },
      ],
      usage: {
        input: 478,
        output: 40,
        cacheRead: 2048,
        cacheWrite: 0,
        reasoning: 20,
        totalTokens: 2566,
        cost: {
          input: 0.001434,
          output: 0.0006,
          cacheRead: 0.0006144,
          cacheWrite: 0,
          total: 0.0026484,
        },
      },
      stopReason: "stop",
    },
  }),
  JSON.stringify({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: '{"ok": true}' }],
      usage: {
        input: 478,
        output: 40,
        cacheRead: 2048,
        cacheWrite: 0,
        reasoning: 20,
        totalTokens: 2566,
        cost: { total: 0.0026484 },
      },
      stopReason: "stop",
    },
    toolResults: [],
  }),
  JSON.stringify({ type: "agent_end", messages: [] }),
].join("\n");

// pi surfaces an LLM failure as an assistant message with stopReason "error"
// and an errorMessage, typically exiting 0.
const PI_TURN_ERROR = [
  JSON.stringify({ type: "agent_start" }),
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "429 rate limit exceeded",
    },
  }),
].join("\n");

Deno.test("buildPiCommand: actor is yolo-by-default (no --tools flag), readonly allowlists read only", () => {
  const actor = buildPiCommand(
    "pi",
    "openrouter/moonshotai/kimi-k3",
    "do it",
    "actor",
  );
  assertEquals(actor.cmd, [
    "pi",
    "--print",
    "--mode",
    "json",
    "--no-session",
    "-m",
    "openrouter/moonshotai/kimi-k3",
    "do it",
  ]);
  const ro = buildPiCommand(
    "pi",
    "openrouter/moonshotai/kimi-k3",
    "look",
    "readonly",
  );
  assertEquals(ro.cmd, [
    "pi",
    "--print",
    "--mode",
    "json",
    "--no-session",
    "-m",
    "openrouter/moonshotai/kimi-k3",
    "--tools",
    "read",
    "look",
  ]);
});

Deno.test("extractText: pi joins assistant text parts, excludes thinking", () => {
  assertEquals(extractTextFromOutput("pi", PI_STREAM_OK), '{"ok": true}');
});

Deno.test("extractUsage: pi sums message_end usage incl cost.total, folds cacheRead into input", () => {
  const u = extractUsage("pi", PI_STREAM_OK);
  // Only message_end is summed (turn_end duplicates the same message).
  assertEquals(u.input, 478 + 2048);
  assertEquals(u.output, 40);
  assertEquals(u.cacheRead, 2048);
  assertEquals(u.reasoning, 20);
  assertEquals(u.total, 478 + 40 + 2048 + 0);
  assertEquals(u.costUsd, 0.0026484);
});

Deno.test("extractError: pi reads stopReason error / errorMessage, classifies retryable", () => {
  const err = extractError("pi", PI_TURN_ERROR);
  assertEquals(err?.message, "429 rate limit exceeded");
  assertEquals(err?.code, "error");
  assertEquals(err?.retryable, true);
  // A clean stream has no error.
  assertEquals(extractError("pi", PI_STREAM_OK), null);
});

Deno.test("extractError: pi reads exhausted auto_retry_end finalError", () => {
  const stream = JSON.stringify({
    type: "auto_retry_end",
    success: false,
    attempt: 3,
    finalError: "quota exceeded",
  });
  const err = extractError("pi", stream);
  assertEquals(err?.message, "quota exceeded");
  assertEquals(err?.retryable, true);
});

Deno.test("buildBwrapArgs: skips binding a credential file or state dir that does not exist on disk", () => {
  // bwrap's --bind/--ro-bind require the SOURCE to exist or the whole
  // invocation fails to start ("Can't find source path ... No such file or
  // directory" — confirmed on roccinante for ~/.codex, which is absent
  // there). Every entry must be conditional on pathExists.
  const exists = () => false;
  const argv = buildBwrapArgs(["echo", "hi"], "/work", "/home/agent", exists);

  assertEquals(argv.includes("/home/agent/.claude"), false);
  assertEquals(argv.includes("/home/agent/.claude/.credentials.json"), false);
  assertEquals(argv.includes("/home/agent/.codex"), false);
  assertEquals(argv.includes("/home/agent/.local/share/opencode"), false);
});

Deno.test("buildBwrapArgs: home is bound via tmpfs+remount-ro bracket (order load-bearing)", () => {
  const exists = () => true;
  const argv = buildBwrapArgs(["echo", "hi"], "/work", "/home/agent", exists);

  const tmpfsIdx = argv.indexOf("--tmpfs");
  // The home tmpfs must appear (there are two --tmpfs uses: /tmp and home).
  const homeTmpfsIdx = argv.indexOf("/home/agent", tmpfsIdx);
  assertEquals(argv[homeTmpfsIdx - 1], "--tmpfs");

  // --remount-ro home must come AFTER all the state-dir/credential binds,
  // i.e. at or near the end, and reference home.
  const remountIdx = argv.indexOf("--remount-ro");
  assertEquals(argv[remountIdx + 1], "/home/agent");
  // Everything bound under home appears before the remount-ro.
  const lastStateBindIdx = Math.max(
    argv.lastIndexOf("/home/agent/.cache"),
    argv.lastIndexOf("/home/agent/.claude"),
  );
  if (lastStateBindIdx !== -1) {
    assertEquals(remountIdx > lastStateBindIdx, true);
  }
});

// --- wrapWithSandbox: Linux bwrap dispatch -----------------------------------
//
// `Deno.build.os` is a read-only property (confirmed: assigning to it throws
// "Cannot assign to read only property"), so these tests cannot force the
// Linux branch on this Darwin dev machine and instead exercise the shared
// `degradeOrThrow` warn/throw contract that both the Darwin and Linux
// branches call identically when their sandbox binary is missing — that
// contract, not the OS check itself, is what these assert. The REAL Linux
// dispatch (bwrap present, argv built, process actually confined) is proved
// end-to-end on roccinante — see the commit body for the full transcript.
// `bwrapPath` is passed here purely to document the parameter exists and is
// plumbed through; it has no effect while Deno.build.os is "darwin".

Deno.test("wrapWithSandbox: sandbox binary missing + not required degrades and warns, regardless of the unused bwrapPath override", () => {
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
    "/nonexistent/bwrap",
  );
  assertEquals(out, cmd);
  assertEquals(warned, true);
  assertEquals(
    String(warnedReason).includes("/nonexistent/sandbox-exec"),
    true,
  );
});

Deno.test("wrapWithSandbox: sandbox binary missing + sandboxRequired throws instead of degrading (shared degradeOrThrow contract)", () => {
  const cmd = ["claude", "--print", "hi"];
  assertThrows(
    () =>
      wrapWithSandbox(
        cmd,
        "/tmp/wd",
        { mode: "seatbelt", profilePath: "/profile.sb", required: true },
        undefined,
        "/nonexistent/sandbox-exec",
        "/nonexistent/bwrap",
      ),
    Error,
    "sandboxRequired is true",
  );
});

Deno.test("buildBwrapArgs: produces a bwrap-shaped argv usable as the tail of a bwrap invocation (structural smoke test)", () => {
  // Full structural check mirroring the exact policy proved on roccinante:
  // namespaces + ro-bind base system + symlinks + proc/dev/tmp + cwd bind +
  // home tmpfs-bracket + trailing real cmd.
  const argv = buildBwrapArgs(
    ["sh", "-c", "echo hi"],
    "/repo",
    "/home/agent",
    () => false,
  );

  assertEquals(argv[0], "--unshare-user");
  assertEquals(argv.includes("--ro-bind"), true);
  assertEquals(argv.includes("/usr"), true);
  assertEquals(argv.includes("--symlink"), true);
  assertEquals(argv.includes("--proc"), true);
  assertEquals(argv.includes("--dev"), true);
  assertEquals(argv.includes("--tmpfs"), true);
  assertEquals(argv.slice(-3), ["sh", "-c", "echo hi"]);
});

// --- Failure classification (classifyFailure / SIGNATURE_TABLE) --------------
//
// Deterministic, table-driven taxonomy consumed by downstream provider-fallback
// gating. The class string values are a stable contract (rate-limit,
// session-limit, contract-violation, agent-declined, infrastructure, unknown).

Deno.test("SIGNATURE_TABLE: version is set and rate-limit / session-limit sets are disjoint", () => {
  assertEquals(SIGNATURE_TABLE.version, "1");
  const overlap = SIGNATURE_TABLE.rateLimit.filter((s) =>
    SIGNATURE_TABLE.sessionLimit.includes(s)
  );
  assertEquals(
    overlap,
    [],
    "rate-limit and session-limit signatures must be disjoint",
  );
});

Deno.test("classifyFailure: a success carries no class (field is omitted)", () => {
  assertEquals(classifyFailure({ success: true }), undefined);
  // A success is a success even if a stray non-fatal error object is present.
  assertEquals(
    classifyFailure({ success: true, exitCode: 0, cleanExit: true }),
    undefined,
  );
});

// Table-driven: every rate-limit signature (as it appears per provider) must
// classify as rate-limit; every session-limit signature as session-limit.
// Signatures are grounded in extractError + the *_RATE_LIMIT / *_QUOTA fixtures.
const RATE_LIMIT_CASES: Array<[string, string, string | undefined]> = [
  ["claude", "Overloaded", "error_overloaded"],
  ["codex", "Rate limit reached for requests", "rate_limit"],
  ["gemini", "Resource has been exhausted (too many requests)", "429"],
  ["grok", "429 Too Many Requests", undefined],
  ["amp", "the service is currently overloaded", undefined],
  ["opencode", "RateLimit: slow down", "ratelimit"],
];

for (const [provider, message, code] of RATE_LIMIT_CASES) {
  Deno.test(`classifyFailure: ${provider} rate-limit signature "${message.slice(0, 24)}" -> rate-limit`, () => {
    assertEquals(
      classifyFailure({
        success: false,
        providerError: { message, code },
      }),
      "rate-limit",
    );
  });
}

const SESSION_LIMIT_CASES: Array<[string, string, string | undefined]> = [
  // opencode is the repo's real captured quota/session-exhaustion shape.
  [
    "opencode",
    "Payment Required: You have exceeded your monthly quota",
    "quota_exceeded",
  ],
  ["codex", "You exceeded your current quota", "insufficient_quota"],
  ["claude", "Session limit reached for this plan", "session_limit"],
  ["grok", "Payment Required", undefined],
];

for (const [provider, message, code] of SESSION_LIMIT_CASES) {
  Deno.test(`classifyFailure: ${provider} session-limit signature "${message.slice(0, 24)}" -> session-limit`, () => {
    assertEquals(
      classifyFailure({
        success: false,
        providerError: { message, code },
      }),
      "session-limit",
    );
  });
}

Deno.test("classifyFailure: rate-limit wins when a message mentions both throttle kinds", () => {
  assertEquals(
    classifyFailure({
      success: false,
      providerError: {
        message: "429 too many requests — upgrade your quota to continue",
      },
    }),
    "rate-limit",
  );
});

Deno.test("classifyFailure: contract-violation wins even on a clean process exit", () => {
  assertEquals(
    classifyFailure({
      success: false,
      cleanExit: true,
      exitCode: 0,
      contractViolation: true,
    }),
    "contract-violation",
  );
  // ...and even if a provider error is also present, the declared-contract
  // failure takes precedence (invokeAndParse's JSON requirement).
  assertEquals(
    classifyFailure({
      success: false,
      contractViolation: true,
      providerError: { message: "rate limit" },
    }),
    "contract-violation",
  );
});

Deno.test("classifyFailure: a provider error that isn't throttling classifies as unknown, not infrastructure", () => {
  assertEquals(
    classifyFailure({
      success: false,
      providerError: {
        message: "unknown model id 'gpt-9'",
        code: "invalid_request",
      },
    }),
    "unknown",
  );
});

Deno.test("classifyFailure: timeouts and non-zero exits with no provider error are infrastructure", () => {
  // wall/idle timeout
  assertEquals(
    classifyFailure({
      success: false,
      timedOut: true,
      exitCode: 143,
      cleanExit: false,
    }),
    "infrastructure",
  );
  // spawn/sandbox/killed non-zero exit
  assertEquals(
    classifyFailure({ success: false, exitCode: 137, cleanExit: false }),
    "infrastructure",
  );
  assertEquals(
    classifyFailure({ success: false, exitCode: 1, cleanExit: false }),
    "infrastructure",
  );
});

Deno.test("classifyFailure: clean exit but success:false with no other signal is agent-declined", () => {
  assertEquals(
    classifyFailure({ success: false, cleanExit: true, exitCode: 0 }),
    "agent-declined",
  );
});

Deno.test("classifyFailure: a failure matching nothing else is unknown", () => {
  assertEquals(classifyFailure({ success: false }), "unknown");
});

// --- InvocationSchema round-trip with / without failureClass ----------------

const BASE_INVOCATION = {
  invocationId: "11111111-1111-1111-1111-111111111111",
  provider: "claude" as const,
  model: "opus",
  prompt: "hi",
  promptHash: "abc",
  cwd: "/repo",
  exitCode: 0,
  success: true,
  durationMs: 1234,
  outputBytes: 2,
  outputPreview: "hi",
  retries: 0,
  timedOut: false,
  invokedAt: "2026-07-18T00:00:00.000Z",
};

Deno.test("InvocationSchema: a success record without failureClass parses and round-trips", () => {
  const parsed = InvocationSchema.parse(BASE_INVOCATION);
  assertEquals(parsed.failureClass, undefined);
  assertEquals(JSON.parse(JSON.stringify(parsed)), BASE_INVOCATION);
});

Deno.test("InvocationSchema: a failed record with failureClass parses and round-trips", () => {
  const failed = {
    ...BASE_INVOCATION,
    success: false,
    exitCode: 1,
    failureReason: "provider_error:rate_limit",
    failureClass: "rate-limit" as const,
  };
  const parsed = InvocationSchema.parse(failed);
  assertEquals(parsed.failureClass, "rate-limit");
  assertEquals(JSON.parse(JSON.stringify(parsed)), failed);
});

Deno.test("InvocationSchema: every classifier class value is accepted by the schema enum", () => {
  for (
    const cls of [
      "rate-limit",
      "session-limit",
      "contract-violation",
      "agent-declined",
      "infrastructure",
      "unknown",
    ]
  ) {
    const rec = { ...BASE_INVOCATION, success: false, failureClass: cls };
    assertEquals(InvocationSchema.safeParse(rec).success, true, cls);
  }
});

Deno.test("InvocationSchema: an unknown failureClass value is rejected (closed enum)", () => {
  const rec = {
    ...BASE_INVOCATION,
    success: false,
    failureClass: "totally-bogus",
  };
  assertEquals(InvocationSchema.safeParse(rec).success, false);
});

// Regression: a pre-change persisted payload (no failureClass, no promptTruncated)
// must still parse unchanged — the field is additive and optional.
Deno.test("InvocationSchema: a legacy pre-failureClass payload still parses", () => {
  const legacy = {
    invocationId: "22222222-2222-2222-2222-222222222222",
    provider: "opencode",
    model: "some-model",
    prompt: "old prompt",
    promptHash: "xyz",
    cwd: "/old",
    exitCode: 1,
    success: false,
    durationMs: 42,
    outputBytes: 0,
    outputPreview: "",
    retries: 2,
    timedOut: false,
    failureReason: "exit_1",
    invokedAt: "2026-01-01T00:00:00.000Z",
  };
  const parsed = InvocationSchema.parse(legacy);
  assertEquals(parsed.failureClass, undefined);
  assertEquals(parsed.success, false);
});
