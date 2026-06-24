/**
 * Unit tests for the provider-specific usage and text extractors.
 *
 * The JSONL/JSON fixtures below are real captures from each CLI run against a
 * trivial "reply with hi" prompt, trimmed to the fields the extractors read.
 * They are the ground truth for the per-provider parsing in `cli_agent.ts`.
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  extractError,
  extractTextFromOutput,
  extractUsage,
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

Deno.test("extractTextFromOutput: falls back to raw output when unparseable", () => {
  assertEquals(extractTextFromOutput("amp", "plain text"), "plain text");
  assertEquals(extractTextFromOutput("claude", "plain text"), "plain text");
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
      data: { message: "Too Many Requests", statusCode: 429, isRetryable: true },
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
