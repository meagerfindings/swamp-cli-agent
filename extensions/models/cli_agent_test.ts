/**
 * Unit tests for the provider-specific usage and text extractors.
 *
 * The JSONL/JSON fixtures below are real captures from each CLI run against a
 * trivial "reply with hi" prompt, trimmed to the fields the extractors read.
 * They are the ground truth for the per-provider parsing in `cli_agent.ts`.
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  aggregateAmpUsage,
  aggregateClaudeUsage,
  aggregateCodexUsage,
  arbitrateSignalOutcome,
  buildAmpCommand,
  buildBwrapArgs,
  buildClaudeCommand,
  buildGrokCommand,
  readGlobalAmpMcpServers,
  buildPiCommand,
  canonicalCwd,
  classifyFailure,
  combineDailyUsage,
  collectAmpExports,
  CollectLocalUsageArgsSchema,
  createOnceOrVerify,
  extractError,
  extractTextFromOutput,
  extractUsage,
  filterProviderChildEnv,
  GlobalArgsSchema,
  hashPrompt,
  InvocationIdSchema,
  InvocationLaunchClaimSchema,
  InvocationSchema,
  InvokeArgsSchema,
  isProvider,
  launchCallerInvocation,
  listProvidersFromRegistry,
  model,
  ModelIdSchema,
  normalizeTags,
  parseGrokModelsList,
  PROVIDER_CHILD_ENV_DENYLIST,
  PROVIDERS,
  RepositoryExpectationSchema,
  repositoryStateHash,
  resolveLocalUsageDay,
  resolveEffectiveBackend,
  resolveInvocationId,
  resolveInvocationTimeouts,
  resolveModel,
  runCli,
  SANDBOX_PROFILE_FILENAME,
  SANDBOX_STRICT_PROFILE_FILENAME,
  sandboxConfigFrom,
  scanJsonLines,
  selectAmpCandidateIds,
  SIGNATURE_TABLE,
  timeoutAttribution,
  verifyRepositoryExpectation,
  wrapWithSandbox,
} from "./cli_agent.ts";

Deno.test("local usage: timezone filtering and date validation", () => {
  assertEquals(
    aggregateClaudeUsage([{
      timestamp: "2026-08-01T05:30:00Z",
      sessionId: "session-a",
      message: {
        id: "message-a",
        role: "assistant",
        usage: { input_tokens: 2, output_tokens: 3 },
      },
    }], "2026-07-31", "America/Denver").eventCount,
    1,
  );
  assertThrows(
    () => resolveLocalUsageDay({ date: "2026-02-30", timeZone: "UTC" }),
    Error,
    "Invalid calendar date",
  );
  assertThrows(
    () => resolveLocalUsageDay({ timeZone: "Not/AZone" }),
    Error,
    "Invalid timeZone",
  );
  assertEquals(CollectLocalUsageArgsSchema.safeParse({ date: "07/31/2026" }).success, false);
});

Deno.test("local usage: Claude globally deduplicates latest message and folds cache into processed input", () => {
  const message = (timestamp: string, input_tokens: number) => ({
    timestamp,
    sessionId: "session-a",
    message: {
      id: "message-a",
      role: "assistant",
      usage: {
        input_tokens,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 11,
        output_tokens: 5,
      },
    },
  });
  const usage = aggregateClaudeUsage([
    message("2026-07-31T12:00:00Z", 2),
    message("2026-07-31T12:01:00Z", 3),
    { malformed: true },
  ], "2026-07-31", "UTC");
  assertEquals(usage.sessionCount, 1);
  assertEquals(usage.eventCount, 1);
  assertEquals(usage.inputTokens, 21);
  assertEquals(usage.totalTokens, 26);
  assertEquals(usage.totalTokens, usage.inputTokens + usage.outputTokens);
  assertEquals(usage.cacheReadTokens + usage.cacheWriteTokens <= usage.inputTokens, true);
});

Deno.test("local usage: Claude assigns a request to its latest valid completion", () => {
  const row = (timestamp: unknown, input: unknown) => ({
    timestamp,
    sessionId: "session-a",
    requestId: "request-a",
    message: {
      id: "message-a",
      role: "assistant",
      usage: { input_tokens: input, output_tokens: 3 },
    },
  });
  const records = [
    row("2026-07-31T23:59:00Z", 2),
    row("2026-08-01T00:01:00Z", 5),
    row(null, 999),
    row("2026-08-01T00:02:00Z", "bad"),
  ];
  assertEquals(aggregateClaudeUsage(records, "2026-07-31", "UTC").eventCount, 0);
  const usage = aggregateClaudeUsage(records, "2026-08-01", "UTC");
  assertEquals(usage.eventCount, 1);
  assertEquals(usage.inputTokens, 5);
  assertEquals(usage.totalTokens, 8);
});

Deno.test("local usage: Codex deltas cumulative snapshots across midnight", () => {
  const snapshot = (
    timestamp: string,
    input: number,
    cached: number,
    output: number,
    reasoning: number,
    cacheWrite: number,
  ) => ({
    timestamp,
    payload: {
      type: "token_count",
      info: { total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_input_tokens: cacheWrite,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      } },
    },
  });
  const usage = aggregateCodexUsage([[
    snapshot("2026-07-30T23:00:00Z", 100, 30, 20, 5, 4),
    snapshot("2026-07-31T10:00:00Z", 150, 40, 30, 8, 6),
    snapshot("2026-07-31T10:30:00Z", 150, 40, 30, 8, 6),
    snapshot("2026-07-31T11:00:00Z", 210, 70, 50, 15, 11),
    snapshot("2026-08-01T11:00:00Z", 300, 90, 70, 20, 14),
  ]], "2026-07-31", "UTC");
  assertEquals(usage.sessionCount, 1);
  assertEquals(usage.eventCount, 2);
  assertEquals(usage.inputTokens, 110);
  assertEquals(usage.outputTokens, 30);
  assertEquals(usage.cacheReadTokens, 40);
  assertEquals(usage.cacheWriteTokens, 7);
  assertEquals(usage.reasoningTokens, 10);
  assertEquals(usage.totalTokens, 140);
  assertEquals(usage.totalTokens, usage.inputTokens + usage.outputTokens);
});

Deno.test("local usage: Codex handles resets and skips malformed baselines", () => {
  const snapshot = (timestamp: string, input: unknown, output: number, cached = 0) => ({
    timestamp,
    payload: {
      type: "token_count",
      info: { total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
      } },
    },
  });
  const usage = aggregateCodexUsage([[
    snapshot("2026-07-30T23:00:00Z", 100, 20, 30),
    snapshot("2026-07-31T01:00:00Z", 120, 25, 35),
    snapshot("2026-07-31T02:00:00Z", "bad", 999),
    snapshot("2026-07-31T03:00:00Z", 10, 2, 2),
    snapshot("2026-07-31T04:00:00Z", 15, 3, 3),
  ]], "2026-07-31", "UTC");
  assertEquals(usage.sessionCount, 1);
  assertEquals(usage.eventCount, 3);
  assertEquals(usage.inputTokens, 35);
  assertEquals(usage.outputTokens, 8);
  assertEquals(usage.cacheReadTokens, 8);
  assertEquals(usage.totalTokens, 43);

  const zero = aggregateCodexUsage([[
    snapshot("2026-07-30T23:00:00Z", 100, 20),
    snapshot("2026-07-31T01:00:00Z", 100, 20),
  ]], "2026-07-31", "UTC");
  assertEquals(zero.sessionCount, 0);
  assertEquals(zero.eventCount, 0);
});

Deno.test("local usage: Codex optional counters cannot fake resets or exceed input deltas", () => {
  const row = (timestamp: unknown, usage: Record<string, unknown>) => ({
    timestamp,
    payload: { type: "token_count", info: { total_token_usage: usage } },
  });
  const optionalDisappears = aggregateCodexUsage([[
    row("2026-07-30T23:00:00Z", {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 20,
      reasoning_output_tokens: 5,
    }),
    row("2026-07-31T01:00:00Z", { input_tokens: 110, output_tokens: 22 }),
  ]], "2026-07-31", "UTC");
  assertEquals(optionalDisappears.inputTokens, 10);
  assertEquals(optionalDisappears.outputTokens, 2);
  assertEquals(optionalDisappears.cacheReadTokens, 0);

  const inconsistent = aggregateCodexUsage([[
    row("2026-07-30T23:00:00Z", {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 0,
    }),
    row("2026-07-31T01:00:00Z", {
      input_tokens: 105,
      output_tokens: 22,
      cached_input_tokens: 10,
    }),
    row(null, { input_tokens: 999, output_tokens: 999 }),
    row("2026-07-31T02:00:00Z", {
      input_tokens: 120,
      output_tokens: 25,
      cached_input_tokens: 12,
    }),
  ]], "2026-07-31", "UTC");
  assertEquals(inconsistent.eventCount, 1);
  assertEquals(inconsistent.inputTokens, 20);
  assertEquals(inconsistent.outputTokens, 5);
  assertEquals(inconsistent.cacheReadTokens, 12);
  assertEquals(inconsistent.totalTokens, 25);
  assertEquals(inconsistent.cacheReadTokens <= inconsistent.inputTokens, true);
});

Deno.test("local usage: Amp dedup is versioned, deterministic, and counts sessions", () => {
  const assistant = (
    protocolMessageID: string,
    protocolMessageVersion: number,
    totalInputTokens: number,
  ) => ({
    role: "assistant",
    protocolMessageID,
    protocolMessageVersion,
    usage: {
      timestamp: "2026-07-31T15:00:00Z",
      totalInputTokens,
      outputTokens: 4,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 2,
      reasoningTokens: 3,
    },
  });
  const threads = [
    { threadId: "thread-a", export: { messages: [assistant("protocol-a", 1, 10)] } },
    {
      threadId: "thread-b",
      export: { messages: [assistant("protocol-a", 2, 12), assistant("protocol-b", 1, 20)] },
    },
  ];
  const usage = aggregateAmpUsage(threads, "2026-07-31", "UTC");
  assertEquals(usage.sessionCount, 2);
  assertEquals(usage.eventCount, 2);
  assertEquals(usage.inputTokens, 32);
  assertEquals(usage.outputTokens, 8);
  assertEquals(usage.cacheReadTokens, 10);
  assertEquals(usage.cacheWriteTokens, 4);
  assertEquals(usage.totalTokens, 40);
  assertEquals(
    aggregateAmpUsage([...threads].reverse(), "2026-07-31", "UTC"),
    usage,
  );
  const malformedHigherVersion = {
    ...assistant("protocol-a", 3, 99),
    protocolMessageVersion: "bad",
  };
  assertEquals(
    aggregateAmpUsage([{
      threadId: "thread-a",
      export: { messages: [assistant("protocol-a", 2, 12), malformedHigherVersion] },
    }], "2026-07-31", "UTC").inputTokens,
    12,
  );
  assertEquals(usage.totalTokens, usage.inputTokens + usage.outputTokens);
  assertEquals(usage.cacheReadTokens + usage.cacheWriteTokens <= usage.inputTokens, true);
});

Deno.test("local usage: JSONL scanning skips malformed and continues", () => {
  const values: unknown[] = [];
  scanJsonLines('\n{"valid":1}\nnot-json\n{"valid":2}\n', (value) => values.push(value));
  assertEquals(values, [{ valid: 1 }, { valid: 2 }]);
});

Deno.test("local usage: Amp candidates honor real updated field and timezone", () => {
  const seen = new Set<string>();
  assertEquals(selectAmpCandidateIds([
    { id: "old", updated: "2026-07-31T05:59:59Z" },
    { id: "today", updated: "2026-07-31T06:00:00Z" },
    { id: "later", updated: "2026-08-01T06:00:00Z" },
    { id: "unknown" },
  ], "2026-07-31", "America/Denver", seen), ["today", "later", "unknown"]);
  assertEquals(selectAmpCandidateIds([
    { id: "today", updated: "2026-07-31T12:00:00Z" },
  ], "2026-07-31", "America/Denver", seen), []);
  assertEquals(selectAmpCandidateIds([
    { id: "moves", updated: "2026-07-31T05:00:00Z" },
    { id: "moves", updated: "2026-07-31T07:00:00Z" },
  ], "2026-07-31", "America/Denver"), ["moves"]);
});

Deno.test("local usage: Amp pagination deduplicates exports", async () => {
  const calls: string[][] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `thread-${index}`,
    updated: "2026-07-31T12:00:00Z",
  }));
  const runner = (args: string[]) => {
    calls.push(args);
    if (args[1] === "list") {
      const offset = args.at(-1);
      return Promise.resolve(JSON.stringify(offset === "0" ? firstPage : [firstPage[0]]));
    }
    return Promise.resolve(JSON.stringify({ messages: [] }));
  };
  const exports = await collectAmpExports("amp", "2026-07-31", "UTC", runner);
  assertEquals(exports.length, 100);
  assertEquals(calls.filter((args) => args[1] === "list").length, 2);
  assertEquals(calls.filter((args) => args[1] === "export").length, 100);
});

Deno.test("local usage: combined totals are elementwise provider sums", () => {
  const providers = [
    aggregateClaudeUsage([], "2026-07-31", "UTC"),
    aggregateAmpUsage([], "2026-07-31", "UTC"),
    aggregateCodexUsage([], "2026-07-31", "UTC"),
  ];
  providers[0].sessionCount = 1;
  providers[0].inputTokens = 10;
  providers[0].outputTokens = 1;
  providers[0].totalTokens = 11;
  providers[1].sessionCount = 2;
  providers[1].inputTokens = 20;
  providers[1].outputTokens = 2;
  providers[1].totalTokens = 22;
  providers[2].sessionCount = 3;
  providers[2].inputTokens = 30;
  providers[2].outputTokens = 3;
  providers[2].totalTokens = 33;
  const combined = combineDailyUsage(providers);
  assertEquals(combined.sessionCount, 6);
  assertEquals(combined.inputTokens, 60);
  assertEquals(combined.outputTokens, 6);
  assertEquals(combined.totalTokens, 66);
  assertEquals(combined.totalTokens, combined.inputTokens + combined.outputTokens);
});

Deno.test("InvokeArgsSchema: validates idle and wall timeout overrides independently", () => {
  const parsed = InvokeArgsSchema.parse({
    prompt: "make one bounded edit",
    idleTimeoutMs: 600_000,
    wallTimeoutMs: 900_000,
  });

  assertEquals(parsed.idleTimeoutMs, 600_000);
  assertEquals(parsed.wallTimeoutMs, 900_000);
  assertEquals(
    InvokeArgsSchema.safeParse({ prompt: "x", idleTimeoutMs: 999 }).success,
    false,
  );
  assertEquals(
    InvokeArgsSchema.safeParse({ prompt: "x", wallTimeoutMs: 3_600_001 })
      .success,
    false,
  );
});

Deno.test("RepositoryExpectationSchema requires complete strict constraints", () => {
  const complete = {
    attachedBranch: "main",
    headSha: "a".repeat(40),
    stateHash: "b".repeat(64),
  };
  assertEquals(RepositoryExpectationSchema.safeParse(complete).success, true);
  for (const missing of ["attachedBranch", "headSha", "stateHash"] as const) {
    const partial: Record<string, unknown> = { ...complete };
    delete partial[missing];
    assertEquals(RepositoryExpectationSchema.safeParse(partial).success, false);
  }
  assertEquals(
    InvokeArgsSchema.safeParse({
      prompt: "x",
      invocationId: "repository-owned",
      repositoryExpectation: complete,
    }).success,
    true,
  );
  assertEquals(
    InvokeArgsSchema.safeParse({
      prompt: "x",
      repositoryExpectation: { attachedBranch: "main" },
    }).success,
    false,
  );
  assertEquals(
    InvokeArgsSchema.parse({ prompt: "x" }).repositoryExpectation,
    undefined,
  );
});

Deno.test("invoke and invokeAndParse both require caller-owned IDs for repository expectations", () => {
  const repositoryExpectation = {
    attachedBranch: "main",
    headSha: "a".repeat(40),
    stateHash: "b".repeat(64),
  };
  for (const methodName of ["invoke", "invokeAndParse"] as const) {
    const schema = model.methods[methodName].arguments;
    const generatedIdCombination = schema.safeParse({
      prompt: "x",
      repositoryExpectation,
    });
    assertEquals(generatedIdCombination.success, false);
    if (!generatedIdCombination.success) {
      assertEquals(generatedIdCombination.error.issues[0].path, [
        "invocationId",
      ]);
      assertStringIncludes(
        generatedIdCombination.error.issues[0].message,
        "invocationId is required",
      );
    }
    assertEquals(
      schema.safeParse({
        prompt: "x",
        invocationId: "repository-owned",
        repositoryExpectation,
      }).success,
      true,
    );
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    cwd,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout).trim();
}

async function withRepository(
  test: (
    cwd: string,
    expectation: { attachedBranch: string; headSha: string; stateHash: string },
  ) => Promise<void>,
): Promise<void> {
  // Canonicalize: on macOS Deno.makeTempDir() returns a /var/folders path that
  // symlinks to /private/var, which verifyRepositoryExpectation rejects as
  // non-canonical. Mirror the production canonicalCwd() so the test exercises
  // the real path contract instead of failing on the symlink.
  const cwd = await canonicalCwd(await Deno.makeTempDir());
  try {
    await git(cwd, "init", "-b", "main");
    await git(cwd, "config", "user.email", "test@example.com");
    await git(cwd, "config", "user.name", "Test");
    await Deno.writeTextFile(`${cwd}/tracked.txt`, "initial\n");
    await git(cwd, "add", "tracked.txt");
    await git(cwd, "commit", "-m", "initial");
    await test(cwd, {
      attachedBranch: "main",
      headSha: await git(cwd, "rev-parse", "HEAD"),
      stateHash: await repositoryStateHash(cwd),
    });
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
}

Deno.test("repository expectation accepts matching attached branch, HEAD, and state", async () => {
  await withRepository(async (cwd, expectation) => {
    await verifyRepositoryExpectation(cwd, expectation);
  });
});

Deno.test("repository expectation rejects dirty state before launch", async () => {
  await withRepository(async (cwd, expectation) => {
    await Deno.writeTextFile(`${cwd}/tracked.txt`, "changed\n");
    let launches = 0;
    const launch = async () => {
      await verifyRepositoryExpectation(cwd, expectation);
      launches++;
    };
    await assertRejects(
      launch,
      Error,
      "state mismatch",
    );
    assertEquals(launches, 0);

    await Deno.writeTextFile(`${cwd}/tracked.txt`, "initial\n");
    await launch();
    assertEquals(launches, 1);
  });
});

Deno.test("repository expectation rejects branch and HEAD mismatch before launch", async () => {
  await withRepository(async (cwd, expectation) => {
    for (
      const differing of [
        { ...expectation, attachedBranch: "other" },
        { ...expectation, headSha: "0".repeat(40) },
      ]
    ) {
      let launches = 0;
      await assertRejects(
        async () => {
          await verifyRepositoryExpectation(cwd, differing);
          launches++;
        },
        Error,
        "mismatch",
      );
      assertEquals(launches, 0);
    }
  });
});

Deno.test("InvocationIdSchema: accepts workflow-safe correlation identities", () => {
  for (
    const invocationId of [
      "SF-52D-2-attempt-1",
      "work_item.123_attempt_2",
      "550e8400-e29b-41d4-a716-446655440000",
    ]
  ) {
    assertEquals(InvocationIdSchema.parse(invocationId), invocationId);
    assertEquals(
      InvokeArgsSchema.parse({ prompt: "bounded edit", invocationId })
        .invocationId,
      invocationId,
    );
  }
});

Deno.test("InvocationIdSchema: rejects unsafe or ambiguous artifact identities", () => {
  for (
    const invocationId of [
      "",
      " leading-space",
      "../escape",
      "contains/slash",
      "contains space",
      "-leading-hyphen",
      "a".repeat(129),
    ]
  ) {
    assertEquals(InvocationIdSchema.safeParse(invocationId).success, false);
  }
});

Deno.test("resolveInvocationId: preserves caller identity and generates a UUID when omitted", () => {
  assertEquals(resolveInvocationId("SF-52D-2-attempt-1"), "SF-52D-2-attempt-1");
  const generated = resolveInvocationId();
  assertEquals(InvocationIdSchema.safeParse(generated).success, true);
  assertEquals(generated.length, 36);
});

type Stored = Map<string, Record<string, unknown>>;

function resourceContext(
  stored: Stored = new Map(),
  events: string[] = [],
  afterWrite?: (name: string, data: Record<string, unknown>) => void,
) {
  return {
    stored,
    context: {
      readResource: (name: string) => {
        events.push(`read:${name}`);
        return Promise.resolve(stored.get(name) ?? null);
      },
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        events.push(`write:${spec}:${name}`);
        stored.set(name, structuredClone(data));
        afterWrite?.(name, data);
        return Promise.resolve({ name });
      },
    },
  };
}

async function claim(
  operation: "invoke" | "invokeAndParse" = "invoke",
  overrides: Record<string, unknown> = {},
) {
  return InvocationLaunchClaimSchema.parse({
    operation,
    invocationId: "owned-1",
    provider: "claude",
    model: "sonnet",
    cwd: "/tmp/repo",
    repositoryExpectation: {
      attachedBranch: "main",
      headSha: "a".repeat(40),
      stateHash: "b".repeat(64),
    },
    promptHash: await hashPrompt("prompt"),
    tags: { a: "1", z: "2" },
    definition: {
      id: "def-1",
      name: "agent",
      version: 1,
      tags: { environment: "test" },
    },
    methodName: operation,
    cliPath: "claude",
    idleTimeoutMs: 600_000,
    wallTimeoutMs: 3_600_000,
    maxRetries: 2,
    toolProfile: "actor",
    sandbox: {
      mode: "auto",
      provider: "claude",
      credentialAccess: "provider",
      network: "allow",
      profilePath: "/resolved/sandbox.sb",
      required: false,
    },
    ...overrides,
  });
}

function terminal(
  launchClaim: Awaited<ReturnType<typeof claim>>,
  success = true,
) {
  return {
    invocationId: launchClaim.invocationId,
    provider: launchClaim.provider,
    model: launchClaim.model,
    prompt: "prompt",
    promptTruncated: false,
    promptHash: launchClaim.promptHash,
    cwd: launchClaim.cwd,
    exitCode: success ? 0 : 1,
    success,
    durationMs: 1,
    outputBytes: 2,
    outputPreview: "ok",
    retries: 0,
    timedOut: false,
    failureReason: success ? undefined : "exit_1",
    failureClass: success ? undefined : "infrastructure",
    invokedAt: "2026-07-27T00:00:00.000Z",
    tags: launchClaim.tags,
  };
}

Deno.test("launch claim remains backward compatible when repository expectation is omitted", async () => {
  const c = await claim("invoke", { repositoryExpectation: undefined });
  assertEquals(c.repositoryExpectation, undefined);
});

Deno.test("exact constrained replay skips the launch callback", async () => {
  const c = await claim();
  const stored: Stored = new Map();
  let callbacks = 0;
  const context = resourceContext(stored).context;
  const first = await launchCallerInvocation(context, c, () => {
    callbacks++;
    return Promise.resolve("ok");
  });
  assertEquals(first, { replayed: false, value: "ok" });
  stored.set("invocation-owned-1", terminal(c));
  stored.set("transcript-owned-1", {
    invocationId: "owned-1",
    prompt: "prompt",
    output: "ok",
  });
  assertEquals(
    await launchCallerInvocation(context, c, () => {
      callbacks++;
      throw new Error("replay must not verify or launch");
    }),
    { replayed: true },
  );
  assertEquals(callbacks, 1);
});

Deno.test("launch claim is durable before expectation verification and provider launch", async () => {
  const events: string[] = [];
  const { context } = resourceContext(new Map(), events);
  await launchCallerInvocation(context, await claim(), async () => {
    events.push("verify");
    await Promise.resolve();
    events.push("spawn");
    return Promise.resolve("ok");
  });
  assertEquals(
    events.indexOf("spawn") > events.indexOf(
      "write:invocationLaunchClaim:launch-claim-owned-1",
    ),
    true,
  );
  assertEquals(
    events.indexOf("spawn") > events.lastIndexOf(
      "read:launch-claim-owned-1",
    ),
    true,
  );
  assertEquals(events.indexOf("verify") < events.indexOf("spawn"), true);
});

Deno.test("expectation mismatch leaves a durable partial claim without provider launch", async () => {
  const c = await claim();
  const stored: Stored = new Map();
  let launches = 0;
  const context = resourceContext(stored).context;

  await assertRejects(
    () =>
      launchCallerInvocation(context, c, () => {
        throw new Error("repository expectation state mismatch");
      }),
    Error,
    "state mismatch",
  );
  assertEquals(stored.get("launch-claim-owned-1"), c);
  assertEquals(launches, 0);

  await assertRejects(
    () =>
      launchCallerInvocation(context, c, () => {
        launches++;
        return Promise.resolve("unexpected");
      }),
    Error,
    "Ambiguous prior launch",
  );
  assertEquals(launches, 0);

  await assertRejects(
    async () =>
      launchCallerInvocation(
        context,
        await claim("invoke", {
          repositoryExpectation: {
            ...c.repositoryExpectation,
            stateHash: "c".repeat(64),
          },
        }),
        () => Promise.resolve("unexpected"),
      ),
    Error,
    "Conflicting durable resource",
  );
});

Deno.test("matching successful replay does not spawn", async () => {
  const c = await claim();
  const stored: Stored = new Map<string, Record<string, unknown>>([
    ["launch-claim-owned-1", c],
    ["invocation-owned-1", terminal(c)],
    ["transcript-owned-1", {
      invocationId: "owned-1",
      prompt: "prompt",
      output: "ok",
    }],
  ]);
  let spawns = 0;
  const result = await launchCallerInvocation(
    resourceContext(stored).context,
    c,
    () => {
      spawns++;
      return Promise.resolve("unexpected");
    },
  );
  assertEquals(result, { replayed: true });
  assertEquals(spawns, 0);
});

Deno.test("matching failed replay does not spawn and preserves failure class", async () => {
  const c = await claim();
  const stored: Stored = new Map<string, Record<string, unknown>>([
    ["launch-claim-owned-1", c],
    ["invocation-owned-1", terminal(c, false)],
    ["transcript-owned-1", {
      invocationId: "owned-1",
      prompt: "prompt",
      output: "ok",
    }],
  ]);
  let spawns = 0;
  const error = await assertRejects(
    () =>
      launchCallerInvocation(resourceContext(stored).context, c, () => {
        spawns++;
        return Promise.resolve("unexpected");
      }),
    Error,
    "infrastructure",
  );
  assertEquals(
    (error as { failureClass?: string }).failureClass,
    "infrastructure",
  );
  assertEquals(spawns, 0);
});

Deno.test("partial or malformed terminal evidence fails closed", async () => {
  const c = await claim();
  for (const invocation of [undefined, { bad: true }]) {
    const stored: Stored = new Map<string, Record<string, unknown>>([
      ["launch-claim-owned-1", c],
      ["transcript-owned-1", {
        invocationId: "owned-1",
        prompt: "prompt",
        output: "ok",
      }],
    ]);
    if (invocation) stored.set("invocation-owned-1", invocation);
    await assertRejects(
      () =>
        launchCallerInvocation(
          resourceContext(stored).context,
          c,
          () => Promise.resolve("no"),
        ),
      Error,
      "Ambiguous prior launch",
    );
  }
});

Deno.test("claim conflicts fail closed for fields and operation", async () => {
  const c = await claim();
  for (
    const differing of [
      await claim("invoke", { provider: "amp" }),
      await claim("invoke", {
        repositoryExpectation: {
          attachedBranch: "main",
          headSha: "a".repeat(40),
          stateHash: "c".repeat(64),
        },
      }),
      await claim("invokeAndParse", { methodName: "invokeAndParse" }),
      await claim("invoke", {
        definition: {
          id: "def-1",
          name: "agent",
          version: 1,
          tags: { environment: "production" },
        },
      }),
      await claim("invoke", {
        sandbox: {
          mode: "auto",
          provider: "claude",
          credentialAccess: "provider",
          network: "allow",
          profilePath: "/different/resolved/sandbox.sb",
          required: false,
        },
      }),
    ]
  ) {
    const stored: Stored = new Map([["launch-claim-owned-1", c]]);
    await assertRejects(
      () =>
        launchCallerInvocation(
          resourceContext(stored).context,
          differing,
          () => Promise.resolve("no"),
        ),
      Error,
      "Conflicting durable resource",
    );
  }
});

Deno.test("tags normalize independent of insertion order", () => {
  assertEquals(normalizeTags({ z: "2", a: "1" }), { a: "1", z: "2" });
  assertEquals(normalizeTags(), {});
});

Deno.test("canonicalCwd resolves symlink aliases", async () => {
  const root = await Deno.makeTempDir();
  try {
    const target = `${root}/target`;
    const alias = `${root}/alias`;
    await Deno.mkdir(target);
    await Deno.symlink(target, alias);
    assertEquals(await canonicalCwd(alias), await Deno.realPath(target));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("SHA-256 prompt hashes are stable and full length", async () => {
  assertEquals(
    await hashPrompt("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals((await hashPrompt("abc")).length, 64);
});

Deno.test("createOnceOrVerify accepts equality and rejects conflicts", async () => {
  const stored: Stored = new Map([["thing", { a: 1, b: 2 }]]);
  assertEquals(
    await createOnceOrVerify(resourceContext(stored).context, "spec", "thing", {
      b: 2,
      a: 1,
    }),
    { created: false },
  );
  await assertRejects(
    () =>
      createOnceOrVerify(resourceContext(stored).context, "spec", "thing", {
        a: 2,
      }),
    Error,
    "Conflicting durable resource",
  );
});

Deno.test("createOnceOrVerify ignores undefined object properties after JSON persistence", async () => {
  const stored: Stored = new Map();
  const context = {
    readResource: (name: string) => Promise.resolve(stored.get(name) ?? null),
    writeResource: (
      _spec: string,
      name: string,
      data: Record<string, unknown>,
    ) => {
      stored.set(name, JSON.parse(JSON.stringify(data)));
      return Promise.resolve({ name });
    },
  };
  assertEquals(
    await createOnceOrVerify(context, "spec", "thing", {
      optional: undefined,
      nested: { omitted: undefined, kept: null },
      array: [null],
    }),
    { created: true, handle: { name: "thing" } },
  );
});

Deno.test("replay rejects transcript output inconsistent with outputPreview", async () => {
  const c = await claim();
  const stored: Stored = new Map<string, Record<string, unknown>>([
    ["launch-claim-owned-1", c],
    ["invocation-owned-1", terminal(c)],
    ["transcript-owned-1", {
      invocationId: "owned-1",
      prompt: "prompt",
      output: "different",
    }],
  ]);
  await assertRejects(
    () =>
      launchCallerInvocation(
        resourceContext(stored).context,
        c,
        () => Promise.resolve("no"),
      ),
    Error,
    "Conflicting terminal evidence",
  );
});

Deno.test("successful invokeAndParse replay requires parsedResponse", async () => {
  const c = await claim("invokeAndParse");
  for (const parsedResponse of [undefined, null]) {
    const invocation: Record<string, unknown> = terminal(c);
    if (parsedResponse !== undefined) {
      invocation.parsedResponse = parsedResponse;
    }
    const stored: Stored = new Map<string, Record<string, unknown>>([
      ["launch-claim-owned-1", c],
      ["invocation-owned-1", invocation],
      ["transcript-owned-1", {
        invocationId: "owned-1",
        prompt: "prompt",
        output: "ok",
      }],
    ]);
    await assertRejects(
      () =>
        launchCallerInvocation(
          resourceContext(stored).context,
          c,
          () => Promise.resolve("no"),
        ),
      Error,
      "Conflicting terminal evidence",
    );
  }
});

Deno.test("createOnceOrVerify rejects a differing read-back", async () => {
  const stored: Stored = new Map();
  // Use an explicit context so the post-write mutation affects its backing map.
  const explicit = resourceContext(stored, [], (name) => {
    stored.set(name, { changed: true });
  }).context;
  await assertRejects(
    () => createOnceOrVerify(explicit, "spec", "thing", { expected: true }),
    Error,
    "read-back mismatch",
  );
});

Deno.test("resolveInvocationTimeouts: each invocation override falls back independently", () => {
  const globals = { idleTimeoutMs: 600_000, wallTimeoutMs: 3_600_000 };

  assertEquals(resolveInvocationTimeouts({}, globals), globals);
  assertEquals(resolveInvocationTimeouts({ idleTimeoutMs: 300_000 }, globals), {
    idleTimeoutMs: 300_000,
    wallTimeoutMs: 3_600_000,
  });
  assertEquals(resolveInvocationTimeouts({ wallTimeoutMs: 900_000 }, globals), {
    idleTimeoutMs: 600_000,
    wallTimeoutMs: 900_000,
  });
});

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

Deno.test("runCli: explicit child environment overrides inherited values", async () => {
  const previous = Deno.env.get("PI_CODING_AGENT_DIR");
  try {
    Deno.env.set("PI_CODING_AGENT_DIR", "/host/pi");
    const result = await runCli(
      [
        Deno.execPath(),
        "eval",
        "console.log(Deno.env.get('PI_CODING_AGENT_DIR'))",
      ],
      {
        env: { PI_CODING_AGENT_DIR: "/tmp/disposable-pi" },
        wallTimeoutMs: 10_000,
      },
    );
    assertEquals(result.success, true);
    assertEquals(result.stdout.trim(), "/tmp/disposable-pi");
  } finally {
    if (previous === undefined) Deno.env.delete("PI_CODING_AGENT_DIR");
    else Deno.env.set("PI_CODING_AGENT_DIR", previous);
  }
});

Deno.test("runCli: child PWD matches its requested working directory", async () => {
  const parentDir = await Deno.makeTempDir();
  const requestedDir = await Deno.makeTempDir({
    prefix: "repo-trees-worktree-",
  });
  const previousPwd = Deno.env.get("PWD");

  try {
    Deno.env.set("PWD", parentDir);

    const result = await runCli(
      [
        Deno.execPath(),
        "eval",
        `console.log(JSON.stringify({ cwd: Deno.cwd(), pwd: Deno.env.get("PWD") }))`,
      ],
      { cwd: requestedDir, wallTimeoutMs: 10_000 },
    );

    assertEquals(result.success, true);
    assertEquals(JSON.parse(result.stdout), {
      cwd: await Deno.realPath(requestedDir),
      pwd: requestedDir,
    });
  } finally {
    if (previousPwd === undefined) Deno.env.delete("PWD");
    else Deno.env.set("PWD", previousPwd);
    await Deno.remove(parentDir, { recursive: true });
    await Deno.remove(requestedDir, { recursive: true });
  }
});

const posixOnly = Deno.build.os === "windows";

function denoEval(source: string): string[] {
  return [Deno.execPath(), "eval", source];
}

async function processExists(pid: number): Promise<boolean> {
  if (Deno.build.os === "windows") {
    const output = await new Deno.Command("tasklist.exe", {
      args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(new TextDecoder().decode(output.stderr).trim());
    }
    const row = new TextDecoder().decode(output.stdout).trim();
    return row !== "" && !row.startsWith("INFO:") &&
      row.split(",")[1]?.replaceAll('"', "") === String(pid);
  }

  const status = await new Deno.Command("/bin/kill", {
    args: ["-0", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return status.success;
}

function forceProcessExit(pid: number | undefined): Promise<void> {
  return Promise.resolve().then(() => {
    if (pid === undefined) return;
    try {
      Deno.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  });
}

async function readPidFiles(paths: string[]): Promise<number[]> {
  const values = await Promise.all(paths.map(async (path) => {
    try {
      const value = Number((await Deno.readTextFile(path)).trim());
      return Number.isInteger(value) && value > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }));
  return values.filter((value): value is number => value !== undefined);
}

async function guardedInvocation<T>(
  invocation: Promise<T>,
  pidFiles: string[],
  timeoutMs = 12_000,
): Promise<T> {
  const completed = invocation.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (error) => ({ kind: "rejected" as const, error }),
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: "deadline" }), timeoutMs);
  });
  const first = await Promise.race([completed, deadline]);
  if (first.kind === "fulfilled") {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    return first.value;
  }
  if (first.kind === "rejected") {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    throw first.error;
  }

  const pids = await readPidFiles(pidFiles);
  for (const pid of pids) {
    if (Deno.build.os !== "windows") {
      try {
        Deno.kill(-pid, "SIGKILL");
      } catch { /* group may not be led by this fixture pid */ }
    }
    await forceProcessExit(pid).catch(() => {});
  }

  // Cleanup gets one short settlement window, but expiration has already won:
  // reject even if the invocation settles after the independent deadline.
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    completed.then(() => {
      if (settlementTimer !== undefined) clearTimeout(settlementTimer);
    }),
    new Promise<void>((resolve) => {
      settlementTimer = setTimeout(resolve, 250);
    }),
  ]);
  throw new Error(`runCli exceeded independent ${timeoutMs}ms test guard`);
}

async function withPidFiles<T>(
  count: number,
  fn: (paths: string[]) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir();
  const paths = Array.from(
    { length: count },
    (_, index) => `${dir}/process-${index}.pid`,
  );
  await Promise.all(paths.map((path) => Deno.writeTextFile(path, "")));
  try {
    return await fn(paths);
  } finally {
    const pids = await readPidFiles(paths);
    await Promise.allSettled(pids.map(forceProcessExit));
    await Deno.remove(dir, { recursive: true });
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (await processExists(pid)) {
    if (performance.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assertEquals(
    await processExists(pid),
    false,
    `process ${pid} survived timeout cleanup`,
  );
}

Deno.test("timeoutAttribution: gone after watchdog before TERM is a natural exit", () => {
  assertEquals(timeoutAttribution({ kind: "gone" }, "wall_time_exceeded"), {
    killed: false,
  });
});

Deno.test("timeoutAttribution: only a sent signal receives timeout attribution", () => {
  assertEquals(timeoutAttribution({ kind: "sent" }, "wall_time_exceeded"), {
    killed: true,
    timeoutReason: "wall_time_exceeded",
  });
});

Deno.test("arbitrateSignalOutcome: gone is preserved without fallback", () => {
  let fallbackCalls = 0;
  const outcome = arbitrateSignalOutcome(
    () => ({ kind: "gone" }),
    () => {
      fallbackCalls++;
      return { kind: "sent" };
    },
  );
  assertEquals(outcome.kind, "gone");
  assertEquals(fallbackCalls, 0);
});

Deno.test("arbitrateSignalOutcome: sent is preserved without fallback", () => {
  let fallbackCalls = 0;
  const outcome = arbitrateSignalOutcome(
    () => ({ kind: "sent" }),
    () => {
      fallbackCalls++;
      return { kind: "gone" };
    },
  );
  assertEquals(outcome.kind, "sent");
  assertEquals(fallbackCalls, 0);
});

Deno.test("arbitrateSignalOutcome: dual errors retain both failures", () => {
  const groupError = new Error("group signal denied");
  const directError = new Error("direct kill denied");
  const outcome = arbitrateSignalOutcome(
    () => ({ kind: "error", error: groupError }),
    () => ({ kind: "error", error: directError }),
  );

  assertEquals(outcome.kind, "error");
  if (outcome.kind === "error") {
    assertEquals(outcome.error instanceof AggregateError, true);
    assertEquals((outcome.error as AggregateError).errors, [
      groupError,
      directError,
    ]);
  }
});

Deno.test("arbitrateSignalOutcome: signal error attempts direct KILL fallback", () => {
  let fallbackCalls = 0;
  const original = new Error("group TERM denied");
  const outcome = arbitrateSignalOutcome(
    () => ({ kind: "error", error: original }),
    () => {
      fallbackCalls++;
      return { kind: "sent" };
    },
  );
  assertEquals(outcome.kind, "error");
  assertEquals(fallbackCalls, 1);
  if (outcome.kind === "error") assertEquals(outcome.error, original);
});

Deno.test("runCli: normal process exit is not marked timed out", async () => {
  const result = await guardedInvocation(
    runCli(denoEval('console.log("done")'), {
      wallTimeoutMs: 2_000,
      idleTimeoutMs: 2_000,
    }),
    [],
  );

  assertEquals(result.success, true);
  assertEquals(result.timedOut, false);
  assertEquals(result.timeoutReason, undefined);
  assertEquals(result.stdout.trim(), "done");
});

Deno.test("runCli: wall timeout terminates a hanging direct child", async () => {
  await withPidFiles(1, async ([pidFile]) => {
    const source = `
      await Deno.writeTextFile(${JSON.stringify(pidFile)}, String(Deno.pid));
      console.log("ready");
      setInterval(() => {}, 60_000);
    `;
    const result = await guardedInvocation(
      runCli(denoEval(source), {
        wallTimeoutMs: 1_000,
        idleTimeoutMs: 10_000,
      }),
      [pidFile],
    );

    assertEquals(result.success, false);
    assertEquals(result.timedOut, true);
    assertEquals(result.timeoutReason, "wall_time_exceeded");
    assertEquals(result.stdout.trim(), "ready");
  });
});

Deno.test({
  name: "runCli: stdin failure rejects and kills a hanging child",
  ignore: posixOnly,
  async fn() {
    await withPidFiles(1, async ([pidFile]) => {
      const command = [
        "/bin/sh",
        "-c",
        'printf "%s" "$$" > "$1"; exec 0<&-; sleep 60',
        "stdin-fixture",
        pidFile,
      ];
      let rejection: unknown;
      try {
        await guardedInvocation(
          runCli(command, {
            stdin: "x".repeat(8 * 1024 * 1024),
            wallTimeoutMs: 10_000,
            idleTimeoutMs: 10_000,
          }),
          [pidFile],
        );
      } catch (error) {
        rejection = error;
      }
      const [pid] = await readPidFiles([pidFile]);

      assertEquals(rejection instanceof Error, true);
      assertEquals(
        (rejection as Error).message.includes("independent 12000ms test guard"),
        false,
      );
      await waitForProcessExit(pid);
    });
  },
});

Deno.test({
  name: "runCli: POSIX timeout terminates child and pipe-holding grandchild",
  ignore: posixOnly,
  async fn() {
    await withPidFiles(2, async ([childFile, grandchildFile]) => {
      const grandchildSource = `
        await Deno.writeTextFile(${
        JSON.stringify(grandchildFile)
      }, String(Deno.pid));
        setInterval(() => {}, 60_000);
      `;
      const source = `
        await Deno.writeTextFile(${
        JSON.stringify(childFile)
      }, String(Deno.pid));
        const grandchild = new Deno.Command(Deno.execPath(), {
          args: ["eval", ${JSON.stringify(grandchildSource)}],
          stdout: "inherit", stderr: "inherit"
        }).spawn();
        await grandchild.status;
      `;
      const result = await guardedInvocation(
        runCli(denoEval(source), {
          wallTimeoutMs: 1_000,
          idleTimeoutMs: 10_000,
        }),
        [childFile, grandchildFile],
      );
      const pids = await readPidFiles([childFile, grandchildFile]);
      assertEquals(pids.length, 2, "fixture did not publish both process PIDs");
      const [childPid, grandchildPid] = pids;

      assertEquals(result.success, false);
      assertEquals(result.timedOut, true);
      await Promise.all([
        waitForProcessExit(childPid),
        waitForProcessExit(grandchildPid),
      ]);
    });
  },
});

Deno.test({
  name:
    "runCli: POSIX idle timeout terminates child and pipe-holding descendant",
  ignore: posixOnly,
  async fn() {
    await withPidFiles(2, async ([childFile, descendantFile]) => {
      const descendantSource = `
        await Deno.writeTextFile(${
        JSON.stringify(descendantFile)
      }, String(Deno.pid));
        setInterval(() => {}, 60_000);
      `;
      const source = `
        await Deno.writeTextFile(${
        JSON.stringify(childFile)
      }, String(Deno.pid));
        new Deno.Command(Deno.execPath(), {
          args: ["eval", ${JSON.stringify(descendantSource)}],
          stdout: "inherit", stderr: "inherit"
        }).spawn();
        console.log("ready");
        setInterval(() => {}, 60_000);
      `;
      const result = await guardedInvocation(
        runCli(denoEval(source), {
          wallTimeoutMs: 10_000,
          idleTimeoutMs: 1_000,
        }),
        [childFile, descendantFile],
      );
      const pids = await readPidFiles([childFile, descendantFile]);
      assertEquals(pids.length, 2, "fixture did not publish both process PIDs");
      const [childPid, descendantPid] = pids;

      assertEquals(result.success, false);
      assertEquals(result.timedOut, true);
      assertEquals(result.timeoutReason, "idle_time_exceeded");
      await Promise.all([
        waitForProcessExit(childPid),
        waitForProcessExit(descendantPid),
      ]);
    });
  },
});

Deno.test({
  name: "runCli: POSIX TERM-responsive process returns without full grace",
  ignore: posixOnly,
  async fn() {
    await withPidFiles(1, async ([pidFile]) => {
      const source = `
        await Deno.writeTextFile(${JSON.stringify(pidFile)}, String(Deno.pid));
        Deno.addSignalListener("SIGTERM", () => Deno.exit(0));
        setInterval(() => {}, 60_000);
      `;
      const started = performance.now();
      const result = await guardedInvocation(
        runCli(denoEval(source), {
          wallTimeoutMs: 1_000,
          idleTimeoutMs: 10_000,
        }),
        [pidFile],
      );

      assertEquals(result.success, false);
      assertEquals(result.timedOut, true);
      assertEquals(performance.now() - started < 4_000, true);
    });
  },
});

Deno.test({
  name: "runCli: POSIX TERM-resistant process is escalated to KILL",
  ignore: posixOnly,
  async fn() {
    await withPidFiles(1, async ([pidFile]) => {
      const source = `
        await Deno.writeTextFile(${JSON.stringify(pidFile)}, String(Deno.pid));
        Deno.addSignalListener("SIGTERM", () => {});
        setInterval(() => {}, 60_000);
      `;
      const result = await guardedInvocation(
        runCli(denoEval(source), {
          wallTimeoutMs: 1_000,
          idleTimeoutMs: 10_000,
        }),
        [pidFile],
      );
      const [pid] = await readPidFiles([pidFile]);

      assertEquals(result.success, false);
      assertEquals(result.timedOut, true);
      await waitForProcessExit(pid);
    });
  },
});

Deno.test("runCli: output activity resets idle timeout", async () => {
  await withPidFiles(1, async ([pidFile]) => {
    const source = `
      await Deno.writeTextFile(${JSON.stringify(pidFile)}, String(Deno.pid));
      for (let i = 0; i < 4; i++) {
        console.log(i);
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      setInterval(() => {}, 60_000);
    `;
    const result = await guardedInvocation(
      runCli(denoEval(source), {
        wallTimeoutMs: 3_000,
        idleTimeoutMs: 1_000,
      }),
      [pidFile],
    );

    assertEquals(result.success, false);
    assertEquals(result.timedOut, true);
    assertEquals(result.timeoutReason, "wall_time_exceeded");
    assertEquals(result.stdout.trim().split("\n").length, 4);
  });
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
  assertEquals(
    resolveModel("pi", undefined, "openrouter/moonshotai/kimi-k3"),
    "openrouter/moonshotai/kimi-k3",
  );
  assertThrows(
    () => resolveModel("pi", undefined, "opus"),
    Error,
    "pi requires an explicit provider/model id",
  );
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
  // PI-CONS-1: pi has no stderr-only exit-0 failure class — streams not combined.
  assertEquals(PROVIDERS.pi.combineStreams, false);
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
    provider: "claude",
    credentialAccess: "isolated",
    profilePath: "/some/profile.sb",
    required: false,
  });
  assertEquals(out, cmd);
});

Deno.test("wrapWithSandbox: mode 'seatbelt' + sandbox-exec available produces the correct argv (this machine is Darwin with real sandbox-exec)", () => {
  const cmd = ["claude", "--print", "hi"];
  const out = wrapWithSandbox(cmd, "/tmp/wd", {
    mode: "seatbelt",
    provider: "claude",
    credentialAccess: "isolated",
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
    provider: "claude",
    credentialAccess: "isolated",
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
    {
      mode: "seatbelt",
      provider: "claude",
      credentialAccess: "isolated",
      profilePath: "/profile.sb",
      required: false,
    },
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
        {
          mode: "seatbelt",
          provider: "claude",
          credentialAccess: "isolated",
          profilePath: "/profile.sb",
          required: true,
        },
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

Deno.test("sandboxConfigFrom: selected-provider credential access is the default and can be isolated per invocation", () => {
  const g = GlobalArgsSchema.parse({ defaultProvider: "claude" });
  assertEquals(g.sandboxCredentialAccess, "provider");

  const compatible = sandboxConfigFrom(g, () => "");
  assertEquals(compatible.provider, "claude");
  assertEquals(compatible.credentialAccess, "provider");

  const isolatedCodex = sandboxConfigFrom(g, () => "", {
    provider: "codex",
    sandboxCredentialAccess: "isolated",
  });
  assertEquals(isolatedCodex.provider, "codex");
  assertEquals(isolatedCodex.credentialAccess, "isolated");
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
    provider: "claude",
    credentialAccess: "isolated",
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
    {
      mode: "bwrap",
      provider: "claude",
      credentialAccess: "isolated",
      profilePath: "",
      required: false,
    },
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
        provider: "claude",
        credentialAccess: "isolated",
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
    "/home/agent/.local/share/claude/versions/2.1.218",
    "claude",
    "provider",
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

  // The exact resolved executable is mounted read-only at a stable path. This
  // keeps provider binaries installed under the otherwise-hidden home usable
  // without exposing the rest of their installation tree.
  const executableIdx = argv.indexOf(
    "/home/agent/.local/share/claude/versions/2.1.218",
  );
  assertEquals(argv[executableIdx - 1], "--ro-bind");
  assertEquals(argv[executableIdx + 1], "/run/cli-agent/provider");
  assertEquals(argv.slice(-3), [
    "/run/cli-agent/provider",
    "--print",
    "hi",
  ]);
});

Deno.test("buildBwrapArgs: excludes secret dirs entirely (no bind emitted) even when they exist on disk", () => {
  // Simulate a box where secret dirs DO exist — the function must never bind
  // them regardless, since they are not in STATE_DIRS/CREDENTIAL_FILES.
  const exists = () => true;
  const argv = buildBwrapArgs(
    ["echo", "hi"],
    "/work",
    "/home/agent",
    exists,
    "/usr/bin/echo",
    "claude",
    "isolated",
  );

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

Deno.test("buildBwrapArgs: binds /run/systemd/resolve read-only when it exists (DNS for systemd-resolved)", () => {
  // On systemd-resolved hosts /etc/resolv.conf is a symlink into
  // /run/systemd/resolve. Without binding that directory the symlink is
  // broken inside the sandbox and DNS fails with ENOTFOUND.
  const exists = (p: string) => p === "/run/systemd/resolve";
  const argv = buildBwrapArgs(
    ["claude", "--print", "hi"],
    "/work",
    "/home/agent",
    exists,
    null,
    "claude",
    "provider",
  );

  const idx = argv.indexOf("/run/systemd/resolve");
  assertEquals(idx > -1, true, "expected /run/systemd/resolve in argv");
  assertEquals(argv[idx - 1], "--ro-bind");
  assertEquals(argv[idx + 1], "/run/systemd/resolve");
});

Deno.test("buildBwrapArgs: does not bind /run/systemd/resolve when absent (non-systemd hosts)", () => {
  const exists = () => false;
  const argv = buildBwrapArgs(
    ["claude", "--print", "hi"],
    "/work",
    "/home/agent",
    exists,
    null,
    "claude",
    "provider",
  );

  assertEquals(
    argv.includes("/run/systemd/resolve"),
    false,
    "must not bind /run/systemd/resolve when it does not exist",
  );
});

Deno.test("buildBwrapArgs: cwd bind is placed after --remount-ro home (not shadowed by tmpfs)", () => {
  // When cwd is under home (e.g. /home/user/tmp/work), a --bind before
  // --tmpfs home would be shadowed. The bind must come after --remount-ro.
  const exists = () => false;
  const argv = buildBwrapArgs(
    ["claude", "--print", "hi"],
    "/home/agent/tmp/work",
    "/home/agent",
    exists,
    null,
    "claude",
    "provider",
  );

  const remountIdx = argv.indexOf("--remount-ro");
  const bindIdx = argv.indexOf("--bind");

  // --remount-ro home must come before --bind cwd
  assertEquals(remountIdx > -1, true, "expected --remount-ro in argv");
  assertEquals(bindIdx > -1, true, "expected --bind in argv");
  assertEquals(
    remountIdx < bindIdx,
    true,
    "--remount-ro must come before --bind (cwd) so tmpfs doesn't shadow the workspace",
  );

  // The --bind target is the cwd
  assertEquals(argv[bindIdx + 1], "/home/agent/tmp/work");
  assertEquals(argv[bindIdx + 2], "/home/agent/tmp/work");
});

Deno.test("buildBwrapArgs: binds existing state dirs writable and masks existing credential files with /dev/null", () => {
  const existing = new Set([
    "/home/agent/.claude",
    "/home/agent/.claude/.credentials.json",
    "/home/agent/.cache",
    "/home/agent/.local/state",
  ]);
  const exists = (p: string) => existing.has(p);
  const argv = buildBwrapArgs(
    ["echo", "hi"],
    "/work",
    "/home/agent",
    exists,
    "/usr/bin/echo",
    "claude",
    "isolated",
  );

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
  assertEquals(argv.includes("/home/agent/.local/state"), true);
  assertEquals(argv.includes("/home/agent/.codex"), false);
});

Deno.test("buildBwrapArgs: exposes a home-installed Node runtime for provider scripts", () => {
  const argv = buildBwrapArgs(
    ["gemini", "--output-format", "json", "prompt"],
    "/work",
    "/home/agent",
    () => false,
    "/home/agent/.local/share/gemini/gemini.js",
    "gemini",
    "provider",
    "/home/agent/.local/share/fnm/node",
    "/home/agent/.local/share/gemini",
  );

  const packageIndex = argv.indexOf("/home/agent/.local/share/gemini");
  assertEquals(argv[packageIndex - 1], "--ro-bind");
  assertEquals(argv[packageIndex + 1], "/run/cli-agent/provider-package");
  const nodeIndex = argv.indexOf("/home/agent/.local/share/fnm/node");
  assertEquals(argv[nodeIndex - 1], "--ro-bind");
  assertEquals(argv[nodeIndex + 1], "/run/cli-agent/node");
  const pathIndex = argv.indexOf("PATH");
  assertEquals(argv[pathIndex - 1], "--setenv");
  assertEquals(argv[pathIndex + 1].startsWith("/run/cli-agent:"), true);
  assertEquals(argv.slice(-4), [
    "/run/cli-agent/provider-package/gemini.js",
    "--output-format",
    "json",
    "prompt",
  ]);
});

Deno.test("buildBwrapArgs: exposes Gemini state only to Gemini in provider credential mode", () => {
  const build = (
    provider: "gemini" | "claude",
    access: "provider" | "isolated",
  ) =>
    buildBwrapArgs(
      [provider, "prompt"],
      "/work",
      "/home/agent",
      (path) => path === "/home/agent/.gemini",
      null,
      provider,
      access,
    );

  assertEquals(
    build("gemini", "provider").includes("/home/agent/.gemini"),
    true,
  );
  assertEquals(
    build("gemini", "isolated").includes("/home/agent/.gemini"),
    false,
  );
  assertEquals(
    build("claude", "provider").includes("/home/agent/.gemini"),
    false,
  );
});

Deno.test("buildBwrapArgs: provider mode exposes only the selected provider's credential files", () => {
  const existing = new Set([
    "/home/agent/.claude",
    "/home/agent/.claude.json",
    "/home/agent/.claude/.credentials.json",
    "/home/agent/.codex",
    "/home/agent/.codex/auth.json",
    "/home/agent/.codex/config.toml",
    "/home/agent/.local/share/opencode",
    "/home/agent/.local/share/opencode/auth.json",
  ]);
  const argv = buildBwrapArgs(
    ["claude", "--print", "hi"],
    "/work",
    "/home/agent",
    (path) => existing.has(path),
    "/usr/bin/claude",
    "claude",
    "provider",
  );

  for (
    const credential of [
      "/home/agent/.claude.json",
      "/home/agent/.claude/.credentials.json",
    ]
  ) {
    const index = argv.indexOf(credential);
    assertEquals(argv[index - 1], "--bind");
    assertEquals(argv[index + 1], credential);
  }

  for (
    const credential of [
      "/home/agent/.codex/auth.json",
      "/home/agent/.codex/config.toml",
      "/home/agent/.local/share/opencode/auth.json",
    ]
  ) {
    const index = argv.indexOf(credential);
    assertEquals(argv[index - 2], "--ro-bind");
    assertEquals(argv[index - 1], "/dev/null");
  }
});

Deno.test("buildBwrapArgs: never exposes the host ~/.pi tree", () => {
  const existing = new Set(["/home/agent/.pi"]);
  const exists = (p: string) => existing.has(p);
  const argv = buildBwrapArgs(
    ["echo", "hi"],
    "/work",
    "/home/agent",
    exists,
    "/usr/bin/echo",
    "pi",
    "provider",
  );
  assertEquals(argv.includes("/home/agent/.pi"), false);
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
  JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
  JSON.stringify({ type: "agent_settled" }),
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

Deno.test("buildPiCommand: disables extensions and sends hostile prompts via stdin", () => {
  const actor = buildPiCommand(
    "pi",
    "openrouter/moonshotai/kimi-k3",
    "--list-models",
    "actor",
  );
  assertEquals(actor.cmd, [
    "pi",
    "--print",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--model",
    "openrouter/moonshotai/kimi-k3",
  ]);
  assertEquals(actor.stdin, "--list-models");
  const ro = buildPiCommand(
    "pi",
    "openrouter/moonshotai/kimi-k3",
    "@/etc/passwd",
    "readonly",
  );
  assertEquals(ro.cmd, [
    "pi",
    "--print",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--model",
    "openrouter/moonshotai/kimi-k3",
    "--tools",
    "read",
  ]);
  assertEquals(ro.stdin, "@/etc/passwd");
  for (
    const prompt of [
      "--list-models",
      "--no-tools",
      "-x",
      "@/etc/passwd",
      "--- YAML-like content",
    ]
  ) {
    const built = buildPiCommand(
      "pi",
      "openrouter/moonshotai/kimi-k3",
      prompt,
      "actor",
    );
    assertEquals(built.cmd.includes(prompt), false, prompt);
    assertEquals(built.stdin, prompt);
  }
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
  const err = extractError(
    "pi",
    [
      PI_TURN_ERROR,
      JSON.stringify({ type: "agent_end", willRetry: false }),
      JSON.stringify({ type: "agent_settled" }),
    ].join("\n"),
  );
  assertEquals(err?.message, "429 rate limit exceeded");
  assertEquals(err?.code, "error");
  assertEquals(err?.retryable, true);
  // A clean stream has no error.
  assertEquals(extractError("pi", PI_STREAM_OK), null);
});

Deno.test("extractError: pi treats stopReason 'aborted' as a provider failure (PI-CORR-2)", () => {
  const stream = [
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "aborted" },
    }),
    JSON.stringify({ type: "agent_end", willRetry: false }),
    JSON.stringify({ type: "agent_settled" }),
  ].join("\n");
  const err = extractError("pi", stream);
  assertEquals(err?.code, "aborted");
  assertEquals(err?.retryable, false);
});

Deno.test("Seatbelt profiles: both deny reads of ~/.pi (PI-SAFE-2)", async () => {
  for (const f of ["cli_agent.sandbox.sb", "cli_agent.sandbox.strict.sb"]) {
    const content = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
    assertEquals(
      content.includes('(subpath (string-append HOME "/.pi"))'),
      true,
      `${f} missing ~/.pi read-deny`,
    );
  }
});

Deno.test("extractError: pi reads exhausted auto_retry_end finalError", () => {
  const stream = [
    JSON.stringify({ type: "agent_end", willRetry: false }),
    JSON.stringify({
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "quota exceeded",
    }),
    JSON.stringify({ type: "agent_settled" }),
  ].join("\n");
  const err = extractError("pi", stream);
  assertEquals(err?.message, "quota exceeded");
  assertEquals(err?.code, "auto_retry_exhausted");
  assertEquals(err?.retryable, false);
});

Deno.test("extractError: pi internal retry success supersedes provisional error", () => {
  const stream = [
    PI_TURN_ERROR,
    JSON.stringify({ type: "agent_end", willRetry: true }),
    JSON.stringify({ type: "auto_retry_start", attempt: 2 }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
        stopReason: "stop",
      },
    }),
    JSON.stringify({ type: "auto_retry_end", success: true, attempt: 2 }),
    JSON.stringify({ type: "agent_end", willRetry: false }),
    JSON.stringify({ type: "agent_settled" }),
  ].join("\n");
  assertEquals(extractError("pi", stream), null);
  assertEquals(extractTextFromOutput("pi", stream), "recovered");
});

Deno.test("extractError: pi rejects truncated or malformed JSONL", () => {
  const truncated = [
    JSON.stringify({ type: "session", version: 3 }),
    JSON.stringify({ type: "agent_start" }),
  ].join("\n");
  assertEquals(extractError("pi", truncated)?.code, "invalid_stream");
  assertEquals(
    extractError("pi", `${PI_STREAM_OK}\nnot-json`)?.code,
    "invalid_stream",
  );
  assertEquals(
    extractError("pi", PI_TURN_ERROR)?.code,
    "invalid_stream",
  );
  const malformedError = [
    PI_TURN_ERROR,
    "not-json",
    JSON.stringify({ type: "agent_end", willRetry: false }),
    JSON.stringify({ type: "agent_settled" }),
  ].join("\n");
  assertEquals(extractError("pi", malformedError)?.code, "invalid_stream");
  const truncatedSuccess = PI_STREAM_OK.split("\n").slice(0, -1).join("\n");
  assertEquals(extractError("pi", truncatedSuccess)?.code, "invalid_stream");
  const truncatedError = [
    PI_TURN_ERROR,
    JSON.stringify({ type: "agent_end", willRetry: false }),
  ].join("\n");
  assertEquals(extractError("pi", truncatedError)?.code, "invalid_stream");
});

Deno.test("buildBwrapArgs: skips binding a credential file or state dir that does not exist on disk", () => {
  // bwrap's --bind/--ro-bind require the SOURCE to exist or the whole
  // invocation fails to start ("Can't find source path ... No such file or
  // directory" — confirmed on roccinante for ~/.codex, which is absent
  // there). Every entry must be conditional on pathExists.
  const exists = () => false;
  const argv = buildBwrapArgs(
    ["echo", "hi"],
    "/work",
    "/home/agent",
    exists,
    "/usr/bin/echo",
    "claude",
    "provider",
  );

  assertEquals(argv.includes("/home/agent/.claude"), false);
  assertEquals(argv.includes("/home/agent/.claude/.credentials.json"), false);
  assertEquals(argv.includes("/home/agent/.codex"), false);
  assertEquals(argv.includes("/home/agent/.local/share/opencode"), false);
});

Deno.test("buildBwrapArgs: home is bound via tmpfs+remount-ro bracket (order load-bearing)", () => {
  const exists = () => true;
  const argv = buildBwrapArgs(
    ["echo", "hi"],
    "/work",
    "/home/agent",
    exists,
    "/usr/bin/echo",
    "claude",
    "isolated",
  );

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
    {
      mode: "seatbelt",
      provider: "claude",
      credentialAccess: "isolated",
      profilePath: "/profile.sb",
      required: false,
    },
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
        {
          mode: "seatbelt",
          provider: "claude",
          credentialAccess: "isolated",
          profilePath: "/profile.sb",
          required: true,
        },
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
  // home tmpfs-bracket + isolated provider executable + trailing arguments.
  const argv = buildBwrapArgs(
    ["sh", "-c", "echo hi"],
    "/repo",
    "/home/agent",
    () => false,
    "/usr/bin/sh",
    "claude",
    "isolated",
  );

  assertEquals(argv[0], "--unshare-user");
  assertEquals(argv.includes("--ro-bind"), true);
  assertEquals(argv.includes("/usr"), true);
  assertEquals(argv.includes("--symlink"), true);
  assertEquals(argv.includes("--proc"), true);
  assertEquals(argv.includes("--dev"), true);
  assertEquals(argv.includes("--tmpfs"), true);
  assertEquals(argv.slice(-3), [
    "/run/cli-agent/provider",
    "-c",
    "echo hi",
  ]);
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

Deno.test("readGlobalAmpMcpServers: returns amp.mcpServers from global settings", async () => {
  const tmpHome = await Deno.makeTempDir({ prefix: "amp-home-" });
  await Deno.mkdir(`${tmpHome}/.config/amp`, { recursive: true });
  await Deno.writeTextFile(
    `${tmpHome}/.config/amp/settings.json`,
    JSON.stringify({
      "amp.mcpServers": { granola: { url: "https://mcp.granola.ai/mcp" } },
      "amp.somethingElse": true,
    }),
  );
  const prevHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpHome);
  try {
    const servers = await readGlobalAmpMcpServers();
    assertEquals(servers, { granola: { url: "https://mcp.granola.ai/mcp" } });
  } finally {
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("readGlobalAmpMcpServers: degrades to {} when settings absent or malformed", async () => {
  const tmpHome = await Deno.makeTempDir({ prefix: "amp-home-" });
  const prevHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpHome);
  try {
    // No settings file at all.
    assertEquals(await readGlobalAmpMcpServers(), {});
    // Malformed JSON.
    await Deno.mkdir(`${tmpHome}/.config/amp`, { recursive: true });
    await Deno.writeTextFile(`${tmpHome}/.config/amp/settings.json`, "{not json");
    assertEquals(await readGlobalAmpMcpServers(), {});
    // Non-object mcpServers.
    await Deno.writeTextFile(
      `${tmpHome}/.config/amp/settings.json`,
      JSON.stringify({ "amp.mcpServers": ["granola"] }),
    );
    assertEquals(await readGlobalAmpMcpServers(), {});
  } finally {
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("buildAmpCommand: settings file carries permissions AND global mcpServers", async () => {
  const tmpHome = await Deno.makeTempDir({ prefix: "amp-home-" });
  await Deno.mkdir(`${tmpHome}/.config/amp`, { recursive: true });
  await Deno.writeTextFile(
    `${tmpHome}/.config/amp/settings.json`,
    JSON.stringify({
      "amp.mcpServers": { granola: { url: "https://mcp.granola.ai/mcp" } },
    }),
  );
  const prevHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpHome);
  try {
    const { cmd, stdin } = await buildAmpCommand(
      "amp",
      "low",
      "list my meetings",
      "readonly",
    );
    assertEquals(stdin, "list my meetings");
    const sfIndex = cmd.indexOf("--settings-file");
    assertEquals(sfIndex >= 0, true);
    const written = JSON.parse(await Deno.readTextFile(cmd[sfIndex + 1]));
    assertEquals(written["amp.mcpServers"], {
      granola: { url: "https://mcp.granola.ai/mcp" },
    });
    // Permissions still present (readonly rejects Bash).
    assertEquals(Array.isArray(written["amp.permissions"]), true);
    await Deno.remove(cmd[sfIndex + 1]);
  } finally {
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
    await Deno.remove(tmpHome, { recursive: true });
  }
});

Deno.test("buildAmpCommand: toolAllowlist fences child to only the named tools", async () => {
  const tmpHome = await Deno.makeTempDir({ prefix: "amp-home-" });
  const prevHome = Deno.env.get("HOME");
  Deno.env.set("HOME", tmpHome);
  try {
    const { cmd } = await buildAmpCommand(
      "amp",
      "low",
      "list my meetings",
      "readonly",
      ["mcp__granola__list_meetings", "mcp__granola__get_meetings"],
    );
    const sfIndex = cmd.indexOf("--settings-file");
    const written = JSON.parse(await Deno.readTextFile(cmd[sfIndex + 1]));
    const perms = written["amp.permissions"] as Array<
      { tool: string; action: string }
    >;
    // Allowlisted tools are allowed.
    for (const tool of ["mcp__granola__list_meetings", "mcp__granola__get_meetings"]) {
      assertEquals(
        perms.some((r) => r.tool === tool && r.action === "allow"),
        true,
      );
    }
    // Everything else is rejected by a trailing catch-all.
    const last = perms[perms.length - 1];
    assertEquals(last.tool, "*");
    assertEquals(last.action, "reject");
    // The profile's Bash reject is preserved and precedes the allows.
    const bashIdx = perms.findIndex((r) =>
      r.tool === "Bash" && r.action === "reject"
    );
    const firstAllowIdx = perms.findIndex((r) => r.action === "allow");
    assertEquals(bashIdx >= 0 && bashIdx < firstAllowIdx, true);
    await Deno.remove(cmd[sfIndex + 1]);
  } finally {
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
    await Deno.remove(tmpHome, { recursive: true });
  }
});
