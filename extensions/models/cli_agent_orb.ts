// Optional whole-work-item Amp orb execution for a Swamp software factory.
// deno-lint-ignore-file no-explicit-any no-import-prefix
import { z } from "npm:zod@4";

const THREAD_URL = "https://ampcode.com/threads/";
const ACTIVE_TRANSPORT_STATES = new Set([
  "claimed",
  "session-bound",
  "recovery-required",
]);

const WorkItemSchema = z.string().regex(
  /^(?![.-])(?!.*[.-]$)[A-Za-z0-9._-]{1,48}$/,
);
const DispatchIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ThreadIdSchema = z.string().regex(
  /^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
);
const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const FactoryIdentitySchema = z.object({
  modelType: z.string().min(1),
  modelId: z.string().uuid(),
  modelName: z.string().min(1),
}).strict();
const FactoryObservationSchema = z.object({
  statusVersion: z.number().int().positive(),
  definitionVersion: z.number().int().positive(),
  lifecycleStatus: z.enum(["active", "terminal"]),
  stageId: z.string().min(1),
  stageCycle: z.number().int().positive(),
  pendingApprovals: z.array(z.string()),
}).strict();
const GitIdentitySchema = z.object({
  cwd: z.string().startsWith("/"),
  repository: z.string().min(1),
  branch: z.string().min(1),
  headSha: ShaSchema,
}).strict();
const OrbDispatchSchema = z.object({
  schemaVersion: z.literal(1),
  executionMode: z.literal("orb"),
  dispatchId: DispatchIdSchema,
  workItem: WorkItemSchema,
  project: z.string().min(1),
  repository: z.string().min(1),
  factoryIdentity: FactoryIdentitySchema,
  orbAgentName: z.string().min(1),
  implementationWorkflow: z.string().min(1),
  completionStage: z.string().min(1),
  completionEvidence: z.string().min(1),
  promptDigest: z.string().length(64),
  transportStatus: z.enum([
    "claimed",
    "session-bound",
    "process-failed",
    "recovery-required",
    "archive-attempted",
    "archived",
  ]),
  threadId: ThreadIdSchema.nullable(),
  threadUrl: z.string().url().nullable(),
  source: GitIdentitySchema,
  checkout: GitIdentitySchema.nullable(),
  factory: FactoryObservationSchema,
  processExitCode: z.number().int().nullable(),
  processTimedOut: z.boolean(),
  archiveStatus: z.enum(["not-ready", "pending", "failed", "archived"]),
  lastError: z.string().max(500).nullable(),
  claimedAt: z.string(),
  updatedAt: z.string(),
}).strict();
type OrbDispatch = z.infer<typeof OrbDispatchSchema>;

const OrbContinuationSchema = z.object({
  dispatchId: DispatchIdSchema,
  continuationId: DispatchIdSchema,
  workItem: WorkItemSchema,
  threadId: ThreadIdSchema,
  promptDigest: z.string().length(64),
  processExitCode: z.number().int().nullable(),
  processTimedOut: z.boolean(),
  recordedAt: z.string(),
}).strict();

const DispatchArgsSchema = z.object({
  workItem: WorkItemSchema,
  dispatchId: DispatchIdSchema,
  executionMode: z.literal("orb"),
  cwd: z.string().startsWith("/"),
  project: z.string().min(1),
  repository: z.string().min(1),
  factoryIdentity: FactoryIdentitySchema,
  orbAgentName: z.string().min(1),
  implementationWorkflow: z.string().min(1),
  completionStage: z.string().min(1),
  completionEvidence: z.string().min(1),
}).strict();
const RegisterArgsSchema = z.object({
  workItem: WorkItemSchema,
  dispatchId: DispatchIdSchema,
  cwd: z.string().startsWith("/"),
}).strict();
const ContinueArgsSchema = z.object({
  workItem: WorkItemSchema,
  dispatchId: DispatchIdSchema,
  continuationId: DispatchIdSchema,
  prompt: z.string().min(1).max(10_000).default(
    "Refresh factory status and continue the named work item from its current governed stage. Stop at human gates.",
  ),
}).strict();
const WorkItemArgsSchema = z.object({
  workItem: WorkItemSchema,
  dispatchId: DispatchIdSchema,
}).strict();
const ArchiveArgsSchema = WorkItemArgsSchema.extend({
  cwd: z.string().startsWith("/"),
}).strict();

type CommandResult = {
  success: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};
export type OrbCommandRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

async function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<CommandResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const output = await new Deno.Command(executable, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).output();
    return {
      success: output.success,
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      timedOut: false,
    };
  } catch (error) {
    const timedOut = error instanceof DOMException &&
      error.name === "AbortError";
    return {
      success: false,
      code: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function git(
  runner: OrbCommandRunner,
  cwd: string,
  ...args: string[]
): Promise<string> {
  const result = await runner("git", args, cwd);
  if (!result.success) {
    throw new Error(`Git identity check failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function normalizeRepository(value: string): string {
  return value.trim()
    .replace(/^git@github\.com:/, "github.com/")
    .replace(/^https?:\/\/github\.com\//, "github.com/")
    .replace(/\.git$/, "");
}

async function readGitIdentity(
  runner: OrbCommandRunner,
  cwd: string,
): Promise<z.infer<typeof GitIdentitySchema>> {
  const canonical = await Deno.realPath(cwd);
  const [topLevel, branch, headSha, repository] = await Promise.all([
    git(runner, canonical, "rev-parse", "--show-toplevel"),
    git(runner, canonical, "symbolic-ref", "--quiet", "--short", "HEAD"),
    git(runner, canonical, "rev-parse", "HEAD"),
    git(runner, canonical, "remote", "get-url", "origin"),
  ]);
  if (canonical !== cwd || topLevel !== canonical) {
    throw new Error("cwd must be the canonical repository root");
  }
  return GitIdentitySchema.parse({
    cwd: canonical,
    repository: normalizeRepository(repository),
    branch,
    headSha,
  });
}

type Metadata = {
  name: string;
  version: number;
  specName?: string;
};
type Repository = {
  findAllForModel: (modelType: string, modelId: string) => Promise<Metadata[]>;
  getContent: (
    modelType: string,
    modelId: string,
    name: string,
    version?: number,
  ) => Promise<Uint8Array | null>;
};

function latest(records: Metadata[], name: string): Metadata {
  const matching = records.filter((record) => record.name === name);
  if (matching.length === 0) throw new Error(`missing authoritative ${name}`);
  const version = Math.max(...matching.map((record) => record.version));
  const selected = matching.filter((record) => record.version === version);
  if (selected.length !== 1) throw new Error(`ambiguous authoritative ${name}`);
  return selected[0];
}

async function decode(
  repository: Repository,
  modelType: string,
  modelId: string,
  metadata: Metadata,
): Promise<unknown> {
  const content = await repository.getContent(
    modelType,
    modelId,
    metadata.name,
    metadata.version,
  );
  if (!content) throw new Error(`missing content for ${metadata.name}`);
  try {
    return JSON.parse(new TextDecoder().decode(content));
  } catch {
    throw new Error(`malformed content for ${metadata.name}`);
  }
}

async function readFactoryObservation(
  repository: Repository,
  identity: z.infer<typeof FactoryIdentitySchema>,
  workItem: string,
): Promise<z.infer<typeof FactoryObservationSchema>> {
  const records = await repository.findAllForModel(
    identity.modelType,
    identity.modelId,
  );
  const stateMeta = latest(records, `state-${workItem}`);
  const statusMeta = latest(records, `status-${workItem}`);
  const state = z.object({
    workItem: z.literal(workItem),
    definitionVersion: z.number().int().positive(),
    status: z.enum(["active", "terminal"]),
    stageId: z.string().min(1),
    cycles: z.record(z.string(), z.number().int().positive()),
  }).passthrough().parse(
    await decode(repository, identity.modelType, identity.modelId, stateMeta),
  );
  const status = z.object({
    workItem: z.literal(workItem),
    definitionVersion: z.number().int().positive(),
    status: z.enum(["active", "terminal"]),
    stage: z.object({
      id: z.string().min(1),
      cycle: z.number().int().positive(),
    })
      .passthrough(),
    pendingApprovals: z.array(z.string()),
  }).passthrough().parse(
    await decode(repository, identity.modelType, identity.modelId, statusMeta),
  );
  if (
    state.definitionVersion !== status.definitionVersion ||
    state.status !== status.status || state.stageId !== status.stage.id ||
    state.cycles[state.stageId] !== status.stage.cycle
  ) throw new Error("primary factory state/status drift");
  return FactoryObservationSchema.parse({
    statusVersion: statusMeta.version,
    definitionVersion: status.definitionVersion,
    lifecycleStatus: status.status,
    stageId: status.stage.id,
    stageCycle: status.stage.cycle,
    pendingApprovals: status.pendingApprovals,
  });
}

async function readDispatches(context: any): Promise<OrbDispatch[]> {
  const records: Metadata[] = await context.dataRepository.findAllForModel(
    context.modelType,
    context.modelId,
  );
  const names = [
    ...new Set(
      records.map((record) => record.name).filter((name) =>
        name.startsWith("orb-dispatch-")
      ),
    ),
  ];
  return await Promise.all(
    names.map(async (name) =>
      OrbDispatchSchema.parse(
        await decode(
          context.dataRepository,
          context.modelType,
          context.modelId,
          latest(records, name),
        ),
      )
    ),
  );
}

function dispatchName(workItem: string): string {
  return `orb-dispatch-${workItem}`;
}

export function factoryOrbPrompt(
  workItem: string,
  dispatchId: string,
  factoryModelName: string,
  orbAgentName: string,
  implementationWorkflow: string,
  completionStage: string,
): string {
  return `Drive existing Software Factory work item ${workItem} through its governed lifecycle in this one orb checkout.

This thread is transport dispatch ${dispatchId}. Do not start the work item again and never invoke an orb-dispatch workflow or dispatchFactoryOrb method from this orb. First refresh ${factoryModelName} status, then register this canonical checkout with ${orbAgentName}.registerFactoryOrbCheckout using workItem=${workItem}, dispatchId=${dispatchId}, and the repository root as cwd.

Load the software-factory skill and obey each current stage. Use the existing record_dispatch, record_artifact, record_evidence, status, approval, and advance contracts and the existing stage workflows. For ${implementationWorkflow} pass executionMode=orb and orbDispatchId=${dispatchId}. Never fabricate a human approval, bypass a gate, split stages into other orbs, merge, deploy, or close feedback. Stop and report when a human gate is pending.

After and only after fresh status reports terminal stage ${completionStage}, call archiveFactoryOrb with this work item, dispatch ID, and canonical cwd. If archival is refused, preserve all work and report the refusal.`;
}

export function launchArguments(
  prompt: string,
  workItem: string,
  project: string,
): string[] {
  return [
    "-ox",
    prompt,
    "--project",
    project,
    "--mode",
    "medium",
    "--title",
    `Factory orb: ${workItem}`,
    "--label",
    "software-factory-orb",
    "--no-archive-after-execute",
    "--stream-json",
  ];
}

export function continuationArguments(
  threadId: string,
  prompt: string,
): string[] {
  return [
    "threads",
    "continue",
    threadId,
    "--orb-execute",
    "--execute",
    prompt,
    "--mode",
    "medium",
    "--stream-json",
  ];
}

export function parseThreadId(output: string): string {
  const ids = new Set<string>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (
        event?.type === "system" && event?.subtype === "init" &&
        typeof event.session_id === "string"
      ) ids.add(ThreadIdSchema.parse(event.session_id));
    } catch {
      // Non-JSON diagnostics are not authoritative thread identity.
    }
  }
  if (ids.size === 0) {
    throw new Error("Amp did not emit a stream init session ID");
  }
  if (ids.size !== 1) throw new Error("Amp emitted conflicting session IDs");
  return [...ids][0];
}

function stableClaimEqual(existing: OrbDispatch, claim: OrbDispatch): boolean {
  const withoutMutable = (record: OrbDispatch) => ({
    executionMode: record.executionMode,
    dispatchId: record.dispatchId,
    workItem: record.workItem,
    project: record.project,
    repository: record.repository,
    factoryIdentity: record.factoryIdentity,
    orbAgentName: record.orbAgentName,
    implementationWorkflow: record.implementationWorkflow,
    completionStage: record.completionStage,
    completionEvidence: record.completionEvidence,
    promptDigest: record.promptDigest,
    source: record.source,
    factory: record.factory,
  });
  return JSON.stringify(withoutMutable(existing)) ===
    JSON.stringify(withoutMutable(claim));
}

function errorSummary(result: CommandResult): string {
  const message = result.timedOut
    ? "Amp process timed out"
    : result.stderr.trim() || `Amp process exited ${result.code}`;
  return message.slice(0, 500);
}

export const orbResources = {
  orbDispatch: {
    description:
      "Durable orb transport claim, session binding, and observations",
    schema: OrbDispatchSchema,
    lifetime: "infinite" as const,
    garbageCollection: 100,
  },
  orbContinuation: {
    description: "Immutable continuation attempt for a bound factory orb",
    schema: OrbContinuationSchema,
    lifetime: "infinite" as const,
    garbageCollection: 100,
  },
};

export const orbMethods = {
  dispatchFactoryOrb: {
    description:
      "Claim and asynchronously dispatch one explicit factory work item to an Amp orb",
    arguments: DispatchArgsSchema,
    execute: async (unknownArgs: unknown, context: any) => {
      const args = DispatchArgsSchema.parse(unknownArgs);
      if (Deno.env.get("AMP_ORB") === "1") {
        throw new Error("recursive factory orb dispatch is forbidden");
      }
      const runner: OrbCommandRunner = context._runAmp ?? runCommand;
      const now = () => (context._now?.() ?? new Date()).toISOString();
      const [source, factory] = await Promise.all([
        readGitIdentity(runner, args.cwd),
        readFactoryObservation(
          context.dataRepository,
          args.factoryIdentity,
          args.workItem,
        ),
      ]);
      if (source.repository !== normalizeRepository(args.repository)) {
        throw new Error(
          "source checkout does not match configured repository",
        );
      }
      if (factory.lifecycleStatus !== "active") {
        throw new Error(
          "only an active primary factory work item can be dispatched",
        );
      }
      const prompt = factoryOrbPrompt(
        args.workItem,
        args.dispatchId,
        args.factoryIdentity.modelName,
        args.orbAgentName,
        args.implementationWorkflow,
        args.completionStage,
      );
      const claimedAt = now();
      const claim = OrbDispatchSchema.parse({
        schemaVersion: 1,
        executionMode: "orb",
        dispatchId: args.dispatchId,
        workItem: args.workItem,
        project: args.project,
        repository: normalizeRepository(args.repository),
        factoryIdentity: args.factoryIdentity,
        orbAgentName: args.orbAgentName,
        implementationWorkflow: args.implementationWorkflow,
        completionStage: args.completionStage,
        completionEvidence: args.completionEvidence,
        promptDigest: await digest(prompt),
        transportStatus: "claimed",
        threadId: null,
        threadUrl: null,
        source,
        checkout: null,
        factory,
        processExitCode: null,
        processTimedOut: false,
        archiveStatus: "not-ready",
        lastError: null,
        claimedAt,
        updatedAt: claimedAt,
      });
      const active = (await readDispatches(context)).filter((record) =>
        ACTIVE_TRANSPORT_STATES.has(record.transportStatus)
      );
      const sameWorkItem = active.find((record) =>
        record.workItem === args.workItem
      );
      if (sameWorkItem) {
        if (stableClaimEqual(sameWorkItem, claim)) return { dataHandles: [] };
        throw new Error(
          "an active orb dispatch already exists for this work item",
        );
      }
      if (active.length >= 1) {
        throw new Error(
          "factory orb concurrency limit 1 is already occupied",
        );
      }
      const claimHandle = await context.writeResource(
        "orbDispatch",
        dispatchName(args.workItem),
        claim,
      );
      const result = await runner(
        context.globalArgs.ampPath ?? "amp",
        launchArguments(prompt, args.workItem, args.project),
        args.cwd,
      );
      let threadId: string | null = null;
      let parseError: string | null = null;
      try {
        threadId = parseThreadId(result.stdout);
      } catch (error) {
        parseError = (error as Error).message;
      }
      const success = result.success && threadId !== null && !parseError;
      const updated = OrbDispatchSchema.parse({
        ...claim,
        transportStatus: success
          ? "session-bound"
          : threadId
          ? "recovery-required"
          : result.success
          ? "recovery-required"
          : "process-failed",
        threadId,
        threadUrl: threadId ? `${THREAD_URL}${threadId}` : null,
        processExitCode: result.code,
        processTimedOut: result.timedOut,
        lastError: success
          ? null
          : (parseError ?? errorSummary(result)).slice(0, 500),
        updatedAt: now(),
      });
      const resultHandle = await context.writeResource(
        "orbDispatch",
        dispatchName(args.workItem),
        updated,
      );
      if (!success) {
        throw new Error(updated.lastError ?? "factory orb dispatch failed");
      }
      return { dataHandles: [claimHandle, resultHandle] };
    },
  },
  registerFactoryOrbCheckout: {
    description: "Bind a canonical orb checkout to its active dispatch",
    arguments: RegisterArgsSchema,
    execute: async (unknownArgs: unknown, context: any) => {
      const args = RegisterArgsSchema.parse(unknownArgs);
      if (Deno.env.get("AMP_ORB") !== "1") {
        throw new Error("orb checkout registration requires AMP_ORB=1");
      }
      const runner: OrbCommandRunner = context._runAmp ?? runCommand;
      const record = (await readDispatches(context)).find((candidate) =>
        candidate.workItem === args.workItem &&
        candidate.dispatchId === args.dispatchId
      );
      if (
        !record || record.transportStatus !== "session-bound" ||
        !record.threadId
      ) {
        throw new Error("active session-bound orb dispatch not found");
      }
      const [checkout, factory] = await Promise.all([
        readGitIdentity(runner, args.cwd),
        readFactoryObservation(
          context.dataRepository,
          record.factoryIdentity,
          args.workItem,
        ),
      ]);
      if (checkout.repository !== record.repository) {
        throw new Error("orb checkout does not match configured repository");
      }
      const updated = OrbDispatchSchema.parse({
        ...record,
        checkout,
        factory,
        updatedAt: (context._now?.() ?? new Date()).toISOString(),
      });
      const handle = await context.writeResource(
        "orbDispatch",
        dispatchName(args.workItem),
        updated,
      );
      return { dataHandles: [handle] };
    },
  },
  refreshFactoryOrbStatus: {
    description:
      "Persist a fresh factory observation without reinterpreting transport state",
    arguments: WorkItemArgsSchema,
    execute: async (unknownArgs: unknown, context: any) => {
      const args = WorkItemArgsSchema.parse(unknownArgs);
      const record = (await readDispatches(context)).find((candidate) =>
        candidate.workItem === args.workItem &&
        candidate.dispatchId === args.dispatchId
      );
      if (!record) throw new Error("factory orb dispatch not found");
      const updated = OrbDispatchSchema.parse({
        ...record,
        factory: await readFactoryObservation(
          context.dataRepository,
          record.factoryIdentity,
          args.workItem,
        ),
        updatedAt: (context._now?.() ?? new Date()).toISOString(),
      });
      const handle = await context.writeResource(
        "orbDispatch",
        dispatchName(args.workItem),
        updated,
      );
      return { dataHandles: [handle] };
    },
  },
  continueFactoryOrb: {
    description:
      "Continue only the persisted remote executor for one active dispatch",
    arguments: ContinueArgsSchema,
    execute: async (unknownArgs: unknown, context: any) => {
      const args = ContinueArgsSchema.parse(unknownArgs);
      if (Deno.env.get("AMP_ORB") === "1") {
        throw new Error(
          "factory orb continuation must be initiated outside an orb",
        );
      }
      const record = (await readDispatches(context)).find((candidate) =>
        candidate.workItem === args.workItem &&
        candidate.dispatchId === args.dispatchId
      );
      if (
        !record || record.transportStatus !== "session-bound" ||
        !record.threadId
      ) {
        throw new Error(
          "continuation requires an active session-bound dispatch",
        );
      }
      const factory = await readFactoryObservation(
        context.dataRepository,
        record.factoryIdentity,
        args.workItem,
      );
      if (factory.lifecycleStatus !== "active") {
        throw new Error("terminal factory work cannot be continued");
      }
      const runner: OrbCommandRunner = context._runAmp ?? runCommand;
      const result = await runner(
        context.globalArgs.ampPath ?? "amp",
        continuationArguments(record.threadId, args.prompt),
        record.source.cwd,
      );
      const continuation = OrbContinuationSchema.parse({
        dispatchId: args.dispatchId,
        continuationId: args.continuationId,
        workItem: args.workItem,
        threadId: record.threadId,
        promptDigest: await digest(args.prompt),
        processExitCode: result.code,
        processTimedOut: result.timedOut,
        recordedAt: (context._now?.() ?? new Date()).toISOString(),
      });
      const handle = await context.writeResource(
        "orbContinuation",
        `orb-continuation-${args.continuationId}`,
        continuation,
      );
      if (!result.success) throw new Error(errorSummary(result));
      return { dataHandles: [handle] };
    },
  },
  archiveFactoryOrb: {
    description:
      "Archive only a clean, successfully completed factory orb with submission evidence",
    arguments: ArchiveArgsSchema,
    execute: async (unknownArgs: unknown, context: any) => {
      const args = ArchiveArgsSchema.parse(unknownArgs);
      const runner: OrbCommandRunner = context._runAmp ?? runCommand;
      const record = (await readDispatches(context)).find((candidate) =>
        candidate.workItem === args.workItem &&
        candidate.dispatchId === args.dispatchId
      );
      if (
        !record || record.transportStatus !== "session-bound" ||
        !record.threadId
      ) {
        throw new Error("archival requires an active session-bound dispatch");
      }
      const factory = await readFactoryObservation(
        context.dataRepository,
        record.factoryIdentity,
        args.workItem,
      );
      if (
        factory.lifecycleStatus !== "terminal" ||
        factory.stageId !== record.completionStage ||
        factory.pendingApprovals.length > 0
      ) {
        throw new Error(
          "only the configured approval-free terminal factory stage can be archived",
        );
      }
      const factoryRecords = await context.dataRepository.findAllForModel(
        record.factoryIdentity.modelType,
        record.factoryIdentity.modelId,
      );
      latest(
        factoryRecords,
        `evidence-${args.workItem}-${record.completionEvidence}`,
      );
      const checkout = await readGitIdentity(runner, args.cwd);
      if (!record.checkout || record.checkout.cwd !== checkout.cwd) {
        throw new Error(
          "archival checkout does not match registered orb lineage",
        );
      }
      const status = await runner("git", ["status", "--porcelain"], args.cwd);
      if (!status.success || status.stdout.trim()) {
        throw new Error("archival requires a clean registered checkout");
      }
      const attemptedAt = (context._now?.() ?? new Date()).toISOString();
      const result = await runner(
        context.globalArgs.ampPath ?? "amp",
        ["threads", "archive", record.threadId],
        args.cwd,
      );
      const updated = OrbDispatchSchema.parse({
        ...record,
        transportStatus: result.success ? "archived" : "archive-attempted",
        factory,
        archiveStatus: result.success ? "archived" : "failed",
        lastError: result.success ? null : errorSummary(result),
        updatedAt: attemptedAt,
      });
      const handle = await context.writeResource(
        "orbDispatch",
        dispatchName(args.workItem),
        updated,
      );
      if (!result.success) {
        throw new Error(updated.lastError ?? "archive failed");
      }
      return { dataHandles: [handle] };
    },
  },
};

// Retain the extension shape for focused tests and repositories that imported
// this module directly before the orb transport became part of the base model.
export const extension = {
  type: "@mgreten/cli-agent",
  description:
    "Optional serialized whole-work-item Amp orb transport for a configured software factory",
  resources: orbResources,
  methods: [orbMethods],
};
