// deno-lint-ignore-file no-import-prefix
import {
  continuationArguments,
  factoryOrbPrompt,
  launchArguments,
  orbMethods,
  parseThreadId,
} from "./cli_agent_orb.ts";
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";

const FACTORY_ID = "5f7712e5-ae86-4465-a9c5-4027f6b30a90";
const ORB_ID = "86c0f35f-679c-48da-a128-9615f7f8b0fc";
const THREAD_ID = "T-12345678-1234-1234-1234-123456789abc";
const cwd = Deno.cwd();
const factoryIdentity = {
  modelType: "@mgreten/software-factory",
  modelId: FACTORY_ID,
  modelName: "example-factory",
};

function result(
  stdout = "",
  success = true,
  stderr = "",
  code: number | null = success ? 0 : 1,
) {
  return { success, code, stdout, stderr, timedOut: false };
}

function dispatchArgs(workItem = "ORB-1") {
  return {
    workItem,
    dispatchId: `dispatch-${workItem}`,
    executionMode: "orb" as const,
    cwd,
    project: "example/project",
    repository: "github.com/example/project",
    factoryIdentity,
    orbAgentName: "example-orb-agent",
    implementationWorkflow: "example-implement",
    completionStage: "complete",
    completionEvidence: "submission",
  };
}

function fixture(options: { ampOutput?: string; ampSuccess?: boolean } = {}) {
  const records = new Map<string, Array<{ name: string; version: number }>>();
  const content = new Map<string, unknown>();
  const writes: Array<[string, string, Record<string, unknown>]> = [];
  const ampCalls: string[][] = [];
  const key = (modelId: string, name: string, version: number) =>
    `${modelId}:${name}:${version}`;
  const add = (modelId: string, name: string, attributes: unknown) => {
    const modelRecords = records.get(modelId) ?? [];
    const version = Math.max(
      0,
      ...modelRecords.filter((record) => record.name === name).map((record) =>
        record.version
      ),
    ) + 1;
    modelRecords.push({ name, version });
    records.set(modelId, modelRecords);
    content.set(key(modelId, name, version), attributes);
    return version;
  };
  const addFactory = (workItem: string, status = "active") => {
    add(FACTORY_ID, `state-${workItem}`, {
      workItem,
      definitionVersion: 1,
      status,
      stageId: status === "active" ? "planning" : "done",
      cycles: { planning: 1, done: 1 },
    });
    add(FACTORY_ID, `status-${workItem}`, {
      workItem,
      definitionVersion: 1,
      status,
      stage: { id: status === "active" ? "planning" : "done", cycle: 1 },
      pendingApprovals: [],
    });
  };
  addFactory("ORB-1");
  addFactory("ORB-2");
  const repository = {
    findAllForModel: (_type: string, modelId: string) =>
      Promise.resolve(records.get(modelId) ?? []),
    getContent: (
      _type: string,
      modelId: string,
      name: string,
      version?: number,
    ) => {
      const selectedVersion = version ?? Math.max(
        0,
        ...(records.get(modelId) ?? []).filter((record) => record.name === name)
          .map((record) => record.version),
      );
      const value = content.get(key(modelId, name, selectedVersion));
      return Promise.resolve(
        value === undefined
          ? null
          : new TextEncoder().encode(JSON.stringify(value)),
      );
    },
  };
  const context = {
    modelType: "@mgreten/cli-agent",
    modelId: ORB_ID,
    globalArgs: { ampPath: "fake-amp" },
    dataRepository: repository,
    _now: () => new Date("2026-08-24T12:00:00Z"),
    _runAmp: (
      executable: string,
      args: string[],
      _commandCwd: string,
    ) => {
      if (executable === "git") {
        const command = args.join(" ");
        if (command === "rev-parse --show-toplevel") {
          return Promise.resolve(result(cwd));
        }
        if (command.includes("symbolic-ref")) {
          return Promise.resolve(result("main"));
        }
        if (command === "rev-parse HEAD") {
          return Promise.resolve(result("a".repeat(40)));
        }
        if (command === "remote get-url origin") {
          return Promise.resolve(
            result("https://github.com/example/project.git"),
          );
        }
        if (command === "status --porcelain") {
          return Promise.resolve(result(""));
        }
      }
      ampCalls.push(args);
      return Promise.resolve(result(
        options.ampOutput ??
          JSON.stringify({
            type: "system",
            subtype: "init",
            session_id: THREAD_ID,
          }),
        options.ampSuccess ?? true,
        options.ampSuccess === false ? "provider failed" : "",
      ));
    },
    writeResource: (
      specName: string,
      name: string,
      attributes: Record<string, unknown>,
    ) => {
      writes.push([specName, name, attributes]);
      add(ORB_ID, name, attributes);
      return Promise.resolve({ name });
    },
  };
  return { context, writes, ampCalls, addFactory };
}

Deno.test("generic orb command builders never enable paid Fast mode", () => {
  const prompt = factoryOrbPrompt(
    "ORB-1",
    "dispatch-ORB-1",
    "example-factory",
    "example-orb-agent",
    "example-implement",
    "complete",
  );
  for (
    const required of [
      "example-factory",
      "example-orb-agent",
      "example-implement",
      "terminal stage complete",
      "record_dispatch",
      "human gate",
      "Never fabricate",
    ]
  ) assert(prompt.includes(required), required);
  const launch = launchArguments(prompt, "ORB-1", "example/project");
  assertEquals(launch.slice(0, 2), ["-ox", prompt]);
  assertEquals(launch.includes("example/project"), true);
  assertEquals(launch.includes("--no-archive-after-execute"), true);
  assertFalse(launch.includes("--fast"));
  assertFalse(launch.includes("--features"));
  assertEquals(
    continuationArguments(THREAD_ID, "continue").slice(0, 7),
    [
      "threads",
      "continue",
      THREAD_ID,
      "--orb-execute",
      "--execute",
      "continue",
      "--mode",
    ],
  );
});

Deno.test("stream init parsing requires one unique valid thread identity", () => {
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: THREAD_ID,
  });
  assertEquals(parseThreadId(`diagnostic\n${init}\n${init}`), THREAD_ID);
  assertThrows(() => parseThreadId("{}"), Error, "did not emit");
  assertThrows(
    () =>
      parseThreadId(`${init}\n${
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "T-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        })
      }`),
    Error,
    "conflicting",
  );
});

Deno.test("dispatch persists claim before session and exact replay never respawns", async () => {
  const f = fixture();
  const method = orbMethods.dispatchFactoryOrb;
  const first = await method.execute(dispatchArgs(), f.context);
  assertEquals(first.dataHandles.length, 2);
  assertEquals(f.writes.map((write) => write[2].transportStatus), [
    "claimed",
    "session-bound",
  ]);
  assertEquals(f.writes[1][2].threadId, THREAD_ID);
  assertEquals(
    f.writes[1][2].threadUrl,
    `https://ampcode.com/threads/${THREAD_ID}`,
  );
  assertEquals(f.ampCalls.length, 1);
  assertFalse(f.ampCalls[0].includes("--fast"));

  assertEquals(
    (await method.execute(dispatchArgs(), f.context)).dataHandles,
    [],
  );
  assertEquals(f.ampCalls.length, 1);
});

Deno.test("dedicated serialized dispatch refuses another active work item before spawn", async () => {
  const f = fixture();
  const method = orbMethods.dispatchFactoryOrb;
  await method.execute(dispatchArgs("ORB-1"), f.context);
  await assertRejects(
    () => method.execute(dispatchArgs("ORB-2"), f.context),
    Error,
    "concurrency limit 1",
  );
  assertEquals(f.ampCalls.length, 1);
});

Deno.test("missing session identity parks durable transport without a blind retry", async () => {
  const f = fixture({ ampOutput: "not-json" });
  await assertRejects(
    () =>
      orbMethods.dispatchFactoryOrb.execute(
        dispatchArgs(),
        f.context,
      ),
    Error,
    "did not emit",
  );
  assertEquals(f.writes.map((write) => write[2].transportStatus), [
    "claimed",
    "recovery-required",
  ]);
  assertEquals(f.ampCalls.length, 1);
});

Deno.test("lowest dispatch boundary rejects recursive orb spawn", () => {
  const source = orbMethods.dispatchFactoryOrb.execute.toString();
  assert(source.includes('Deno.env.get("AMP_ORB") === "1"'));
  assert(
    source.indexOf("recursive factory orb dispatch is forbidden") <
      source.indexOf("readGitIdentity"),
  );
});

Deno.test("archive uses the documented Amp thread command without Fast mode", () => {
  const source = orbMethods.archiveFactoryOrb.execute.toString();
  assert(/"threads",\s*"archive"/.test(source));
  assert(source.includes('transportStatus: result.success ? "archived"'));
  assertFalse(source.includes("--fast"));
});
