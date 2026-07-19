/**
 * Multi-provider CLI agent invoker for swamp.
 *
 * Runs coding-agent CLI tools (claude, opencode, amp, gemini, codex, grok) with
 * typed inputs, captures structured outputs including token counts, cost,
 * duration, exit code, and automatic retries on transient failures. Supports
 * slash command resolution from a configurable commands directory and optional
 * JSON response parsing.
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
  "grok",
]);

/**
 * Domain provider id — derived from the schema. Do not hand-duplicate
 * the string union; adding a ProviderEnum member updates this automatically.
 */
type Provider = z.infer<typeof ProviderEnum>;

/**
 * CLI-specific model identifier as understood by a provider CLI.
 *
 * Open-ended (not a closed union): models belong to each vendor's product
 * surface and change without this extension's release cycle. Use this alias
 * so call sites document intent; do not turn it into an enum of known ids.
 *
 * Non-empty after trim: blank/whitespace is not a model id.
 */
export const ModelIdSchema = z.string().trim().min(1).describe(
  "CLI-specific model id (e.g. opus, sonnet, gpt-5.5, grok-4.5)",
);
export type ModelId = z.infer<typeof ModelIdSchema>;

/** True when `m` is present and non-blank (after trim). */
function isPresentModelId(m: string | undefined): m is ModelId {
  return m !== undefined && m.trim().length > 0;
}

/** True when `p` is a known ProviderEnum member. */
export function isProvider(p: string): p is Provider {
  return ProviderEnum.safeParse(p).success;
}

/**
 * Scoped permission profile applied to a provider's CLI invocation.
 * "readonly" grants read/search tools only; "actor" (the default) additionally
 * allows editing files and running shell commands.
 */
const ToolProfileEnum = z.enum(["readonly", "actor"]);

/**
 * OS-level sandbox engine for the spawned CLI subprocess.
 * "auto" (default) — pick the backend for the current OS: Seatbelt
 * (`sandbox-exec`) on Darwin, bwrap on Linux; degrades (or throws, if
 * `sandboxRequired`) on any other OS or when the chosen backend's binary is
 * missing. "off" — explicit opt-out, no sandbox. "seatbelt" / "bwrap" — force
 * a specific backend regardless of OS-detection (useful for testing or being
 * explicit); if the forced backend doesn't match the running OS or its binary
 * is missing, this also degrades/throws exactly like "auto" on a mismatch.
 */
const SandboxModeEnum = z.enum(["off", "auto", "seatbelt", "bwrap"]);

/** Global configuration arguments shared across all method invocations. */
export const GlobalArgsSchema = z.object({
  defaultProvider: ProviderEnum.default("claude"),
  // Fallback when a provider has no entry-level default in PROVIDERS.
  // Prefer PROVIDERS[provider].defaultModel when the invoke omits `model`
  // (avoids defaultProvider=grok silently using Claude's "opus").
  defaultModel: ModelIdSchema.default("opus"),
  defaultToolProfile: ToolProfileEnum.default("actor"),
  commandsDir: z.string().default(".claude/commands"),
  commandSubdirs: z.array(z.string()).default([]).describe(
    "Additional subdirectories under commandsDir to search for slash commands",
  ),
  claudePath: z.string().default("claude"),
  opencodePath: z.string().default("opencode"),
  ampPath: z.string().default("amp"),
  geminiPath: z.string().default("gemini"),
  codexPath: z.string().default("codex"),
  grokPath: z.string().default("grok"),
  idleTimeoutMs: z.number().default(600_000),
  wallTimeoutMs: z.number().default(3_600_000),
  maxRetries: z.number().default(2),
  // Sandbox: OS-level confinement of the spawned CLI subprocess, DEFAULT ON via
  // "auto" (picks Seatbelt on Darwin / bwrap on Linux; warns-and-degrades, or
  // throws if sandboxRequired, on an unsupported OS or missing binary).
  // Instances that need to opt OUT set sandboxMode: "off" explicitly. See
  // wrapWithSandbox for the wrap point and cli_agent.sandbox.sb for the
  // deny-secrets/allow-egress first-cut policy.
  //
  // NOTE for callers that forward this as a per-invocation override (e.g. the
  // pr-watcher model, which passes its OWN global sandboxMode into this
  // extension's invoke/invokeAndParse `sandboxMode` arg): an explicit override
  // always wins over this default, so a caller whose own default is still
  // "off" will keep disabling the sandbox here even though this default is now
  // "auto". Downstream models must update their own default to inherit auto-on.
  sandboxMode: SandboxModeEnum.default("auto").describe(
    "OS-level sandbox for the spawned CLI: 'auto' (default; picks Seatbelt on Darwin or bwrap on Linux, degrades elsewhere), 'off' (explicit opt-out), 'seatbelt', or 'bwrap' (force a specific backend)",
  ),
  sandboxProfile: z.string().optional().describe(
    "Override path to the Seatbelt .sb profile (defaults to the shipped cli_agent.sandbox.sb, resolved from the extension's files dir)",
  ),
  sandboxRequired: z.boolean().default(false).describe(
    "When true, fail the invocation instead of degrading when a sandbox is requested but the platform can't apply it (no backend for the OS, or the backend's binary is missing). Default false: warn and run unsandboxed.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Schema for a structured invocation record persisted as a swamp resource. */
export const InvocationSchema = z.object({
  invocationId: z.string(),
  provider: ProviderEnum,
  model: ModelIdSchema,
  prompt: z.string(),
  promptTruncated: z.boolean().optional().describe(
    "True when prompt contains only the first 500 characters; absent on records created before this field was added.",
  ),
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
  failureClass: z.enum([
    "rate-limit",
    "session-limit",
    "contract-violation",
    "agent-declined",
    "infrastructure",
    "unknown",
  ]).optional().describe(
    "Typed failure taxonomy for the invocation. Deterministic, additive, and absent on success (and on records created before this field was added). Consumed by downstream provider-fallback gating (only rate-limit/session-limit trigger a fallback).",
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
  parsedResponse: z.unknown().optional().describe(
    "Parsed JSON response from the agent output. Only populated by invokeAndParse.",
  ),
});

/**
 * Schema for the untruncated companion record to an invocation: the full
 * original prompt and the full extracted output, neither subject to the
 * preview caps on the invocation record itself.
 */
const TranscriptSchema = z.object({
  invocationId: z.string(),
  prompt: z.string(),
  output: z.string(),
});

/** Schema for the result of enumerating a provider's available models. */
const ModelListSchema = z.object({
  provider: ProviderEnum,
  models: z.array(ModelIdSchema),
  count: z.number(),
  listedAt: z.string(),
});

/** One entry in the closed PROVIDERS registry (for listProviders discovery). */
const ProviderInfoSchema = z.object({
  id: ProviderEnum,
  defaultModel: ModelIdSchema.optional().describe(
    "Registry default model id when invoke omits model and global defaultModel is still the unconfigured Claude schema default",
  ),
  supportsListModels: z.boolean().describe(
    "True when this provider's CLI can be enumerated via listModels",
  ),
});

/** Domain provider-catalog entry — derived from the schema, not hand-duplicated. */
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

/** Schema for the result of listing supported CLI providers. */
const ProviderListSchema = z.object({
  providers: z.array(ProviderInfoSchema),
  count: z.number(),
  listedAt: z.string(),
});

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

/** Resolved sandbox configuration passed down to {@link wrapWithSandbox}. */
type SandboxConfig = {
  mode: "off" | "auto" | "seatbelt" | "bwrap";
  /**
   * Path to the Seatbelt .sb profile; only read/needed when the EFFECTIVE
   * backend (see {@link resolveEffectiveBackend}) is seatbelt.
   */
  profilePath: string;
  /** Fail closed (throw) instead of warn-and-degrade when unavailable. */
  required: boolean;
};

/** A concrete OS-level sandbox backend, or none (no backend for this OS). */
type SandboxBackend = "seatbelt" | "bwrap" | "none";

/**
 * Pure resolution of {@link SandboxConfig.mode} + a `Deno.build.os`-shaped OS
 * string down to the concrete backend that {@link wrapWithSandbox} should
 * attempt. Extracted as its own exported function (rather than inlined in
 * `wrapWithSandbox`) so the OS-dispatch DECISION can be unit-tested for every
 * mode/OS combination without needing to mock `Deno.build.os` (a read-only
 * property) or touch the filesystem — `wrapWithSandbox` still owns checking
 * whether the resolved backend's binary actually exists.
 *
 * Truth table:
 * - `"off"` + any OS → `"none"` (explicit opt-out; wrapWithSandbox actually
 *   short-circuits on `mode === "off"` before ever calling this, but the pure
 *   mapping is included here for completeness/testability).
 * - `"auto"` + `"darwin"` → `"seatbelt"`.
 * - `"auto"` + `"linux"` → `"bwrap"`.
 * - `"auto"` + anything else (e.g. `"windows"`) → `"none"` (no backend for
 *   this OS; caller degrades-or-throws per `sandboxRequired`).
 * - `"seatbelt"` + any OS → `"seatbelt"` (forced; if the OS isn't darwin or
 *   the binary is missing, `wrapWithSandbox` degrades/throws on that mismatch
 *   — this function only resolves WHICH backend is being requested, not
 *   whether it's actually usable here).
 * - `"bwrap"` + any OS → `"bwrap"` (forced; same mismatch handling as above).
 */
export function resolveEffectiveBackend(
  mode: "off" | "auto" | "seatbelt" | "bwrap",
  os: string,
): SandboxBackend {
  switch (mode) {
    case "off":
      return "none";
    case "seatbelt":
      return "seatbelt";
    case "bwrap":
      return "bwrap";
    case "auto":
      if (os === "darwin") return "seatbelt";
      if (os === "linux") return "bwrap";
      return "none";
  }
}

/**
 * Manifest-relative name of the shipped Seatbelt profile.
 *
 * Resolved at runtime via `ctx.extensionFile()` (see {@link sandboxConfigFrom}),
 * NOT via `import.meta.url`. The `.sb` ships through the manifest `binaries`
 * field, which lands it in the extension's files root — `<ext>/files/` when
 * pulled, alongside the model+manifest in the source tree during dev/test.
 * A previous `new URL("./cli_agent.sandbox.sb", import.meta.url)` resolved
 * relative to `models/cli_agent.ts`, which is correct in the source tree but
 * WRONG once pulled (the binary is in `files/`, not `models/`), so the default
 * profile could not be found at runtime and the sandbox silently failed to
 * load. `ctx.extensionFile()` is the documented, layout-agnostic resolver that
 * works identically in both layouts.
 */
export const SANDBOX_PROFILE_FILENAME = "cli_agent.sandbox.sb";

/**
 * Path to the `bwrap` (bubblewrap) binary on Linux. A fixed constant (not a
 * global-args field) because bwrap is a system-level sandbox helper, not a
 * per-provider CLI path — mirrors how `sandboxExecPath` defaults to a fixed
 * `/usr/bin/sandbox-exec` rather than being user-configurable.
 */
export const BWRAP_PATH = "/usr/bin/bwrap";

/**
 * Absolute paths, relative to `home`, of this extension's own credential
 * files that must be BOTH read- and write-denied inside the sandbox, while
 * their containing directory otherwise stays writable for the CLI's
 * non-credential state (sessions, history, caches).
 *
 * Mirrors the macOS Seatbelt profile's `(literal ...)` read-deny +
 * write-deny entries for `~/.claude.json`, `~/.claude/.credentials.json`,
 * `~/.codex/auth.json`, `~/.codex/config.toml`, and
 * `~/.local/share/opencode/auth.json`. `~/.config/amp` has no single
 * known credential-file literal on the researched machine (the macOS
 * profile denies read of the whole subpath instead) — deliberately NOT
 * bound at all on Linux (see STATE_DIRS below), so it is absent rather
 * than masked.
 *
 * Codex's files (`~/.codex/...`) are included even though `~/.codex` does
 * not exist on the roccinante Linux box this backend was proven on — the
 * bind is skipped when the path is absent (see {@link buildBwrapArgs}), so
 * this list documents intended policy independent of what happens to exist
 * on any one box today.
 */
const CREDENTIAL_FILES: string[] = [
  ".claude.json",
  ".claude/.credentials.json",
  ".codex/auth.json",
  ".codex/config.toml",
  ".local/share/opencode/auth.json",
];

/**
 * Directories, relative to `home`, that are bound WRITABLE into the sandbox
 * because a provider CLI needs to persist its own non-credential state
 * (sessions, history, caches) or a shared toolchain cache. Mirrors the
 * macOS profile's `file-write*` re-allow subpaths
 * (`~/.cache`, `~/.deno`, `~/.claude`, `~/.codex`, `~/.config/opencode`,
 * `~/.local/share/opencode`).
 *
 * Deliberately excludes `~/.config/amp`, `~/.gnupg`, `~/.ssh`, `~/.aws`,
 * etc. — anything not listed here is simply absent inside the sandbox
 * (bwrap's allowlist-by-omission, see {@link buildBwrapArgs} doc comment).
 */
const STATE_DIRS: string[] = [
  ".cache",
  ".deno",
  ".claude",
  ".codex",
  ".config/opencode",
  ".local/share/opencode",
];

/** One `--bind`/`--ro-bind`/`--symlink`/etc. pair or flag emitted into a bwrap argv. */
type BwrapArg = string;

/**
 * Build the `bwrap` argv that wraps `cmd`, translating the same confinement
 * intent as `cli_agent.sandbox.sb` (deny ambient secrets, restrict writes to
 * cwd/tmp/state, allow egress) into bwrap's imperative bind-mount model.
 *
 * Pure and side-effect-free EXCEPT for the injected `pathExists` check, which
 * is required because bwrap (unlike Seatbelt's path-literal rules) needs its
 * bind *source* to exist on disk or the whole invocation fails to start
 * (`bwrap: Can't find source path ... No such file or directory` — confirmed
 * on roccinante for `~/.codex`, which does not exist there). Every
 * STATE_DIRS/CREDENTIAL_FILES entry is therefore bound conditionally; a CLI
 * whose state dir doesn't exist yet on a given box simply gets no bind for
 * it (and, for a credential file specifically, no mask — masking requires
 * the parent directory bind to exist first, and an absent parent means
 * there is nothing on disk to protect anyway).
 *
 * Policy (proved end-to-end on roccinante, see commit body for the full
 * transcript):
 *
 * 1. **Namespaces**: `--unshare-user --unshare-pid --unshare-ipc --unshare-uts`,
 *    `--die-with-parent`, `--new-session`. Network is NOT unshared — egress
 *    control is a later bet, matching the macOS profile's `(allow network*)`.
 * 2. **Read-only base system**: `--ro-bind /usr /usr`, `--ro-bind /etc /etc`,
 *    plus `--symlink usr/bin /bin` (and lib/lib64/sbin) to recreate the
 *    usr-merge symlinks debian/ubuntu-style distros expect — binding `/bin`
 *    etc. directly instead of symlinking fails because they ARE symlinks
 *    into `/usr` on the host; bwrap needs the symlink recreated, not shadowed.
 * 3. `--proc /proc`, `--dev /dev`, `--tmpfs /tmp` (ephemeral scratch, not the
 *    real /tmp).
 * 4. **Workspace**: `--bind cwd cwd` — the only unconditionally-writable path
 *    outside home-relative state dirs.
 * 5. **Home**: `--tmpfs home` FIRST (so `home` becomes a real bwrap mount
 *    point, not merely a synthesized intermediate directory), then the
 *    STATE_DIRS writable sub-binds and CREDENTIAL_FILES masks on top, then
 *    `--remount-ro home` LAST. This ordering is load-bearing: binding
 *    `~/.cache` etc. directly (without the tmpfs+remount-ro bracket) leaves
 *    `home` itself as a bwrap-synthesized writable directory — a process can
 *    `touch $HOME/anything` and it silently "succeeds" into that ephemeral
 *    directory (confirmed on roccinante: exit 0, file invisible outside the
 *    sandbox and never persisted). `--remount-ro` only works on a real bwrap
 *    mount, which is why the leading `--tmpfs home` exists — without it
 *    `--remount-ro` fails with "Unable to find destination in mount table".
 *    Everything NOT explicitly bound under home (`.ssh`, `.aws`,
 *    `.config/gcloud`, `.config/gh`, `.gnupg`, `.config/op`, `.docker`,
 *    `.gemini`, `.npmrc`, ...) is therefore simply absent — allowlist by
 *    omission, avoiding the mask-precedence trap a broad `--bind home home`
 *    would require carefully layering masks on top of (see task brief).
 * 6. **Credential files**: for each existing path in CREDENTIAL_FILES,
 *    `--ro-bind /dev/null <path>` AFTER its containing STATE_DIRS bind —
 *    this masks both read (the process sees an empty /dev/null, never the
 *    real bytes) and write (`/dev/null` is bound read-only, so a write
 *    attempt gets EROFS) while sibling files in the same directory stay
 *    fully readable/writable. Proved on roccinante: reading returns
 *    "Permission denied", writing returns "Permission denied", the real
 *    file's sha256 is unchanged after the attempt, and a sibling test file
 *    in the same directory still round-trips.
 *
 * `home` is required (not defaulted to `Deno.env.get("HOME")` internally)
 * so this stays pure and independently testable; callers pass the resolved
 * value the same way `wrapWithSandbox` already resolves `HOME` for Seatbelt.
 */
export function buildBwrapArgs(
  cmd: string[],
  cwd: string,
  home: string,
  pathExists: (p: string) => boolean,
): string[] {
  const args: BwrapArg[] = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/etc",
    "/etc",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    cwd,
    cwd,
    "--tmpfs",
    home,
  ];

  for (const rel of STATE_DIRS) {
    const abs = `${home}/${rel}`;
    if (pathExists(abs)) {
      args.push("--bind", abs, abs);
    }
  }

  for (const rel of CREDENTIAL_FILES) {
    const abs = `${home}/${rel}`;
    if (pathExists(abs)) {
      args.push("--ro-bind", "/dev/null", abs);
    }
  }

  args.push("--remount-ro", home);
  args.push("--setenv", "HOME", home);

  return [...args, ...cmd];
}

/**
 * Wrap `cmd` in an OS-level sandbox (`sandbox-exec` on macOS, `bwrap` on
 * Linux), or return it unchanged.
 *
 * This is the single seam every provider CLI spawn passes through (via
 * {@link runCli}), so the confinement policy — deny ambient secrets, restrict
 * writes to cwd/tmp/state, allow egress — applies uniformly to
 * claude/codex/amp/gemini/grok/opencode without touching their individual
 * `build*Command` functions. macOS's policy lives in `cli_agent.sandbox.sb`
 * (see that file's header); Linux's equivalent policy is documented on
 * {@link buildBwrapArgs}.
 *
 * Behavior:
 * - `mode: "off"` → returns `cmd` unchanged (no-op; explicit opt-out).
 * - Otherwise the EFFECTIVE backend is resolved via
 *   {@link resolveEffectiveBackend} (`"auto"` → seatbelt on Darwin / bwrap on
 *   Linux / none elsewhere; `"seatbelt"` / `"bwrap"` → that backend, forced):
 *   - effective backend `"seatbelt"`, running on Darwin, with
 *     `/usr/bin/sandbox-exec` present → prefixes `cmd` with
 *     `sandbox-exec -f <profile> -D CWD=<cwd> -D HOME=<home>`.
 *   - effective backend `"bwrap"`, running on Linux, with `bwrap` present →
 *     prefixes `cmd` with the {@link buildBwrapArgs} argv.
 *   - effective backend `"none"` (`"auto"` on an unsupported OS), or the
 *     resolved backend doesn't match the running OS, or its binary is
 *     missing → **warn-and-degrade**: log a loud warning and return `cmd`
 *     unchanged, so an imperfectly-configured swamp install never
 *     hard-crashes on a platform mismatch. UNLESS `required: true`, in which
 *     case this throws instead — the fail-closed path for callers running
 *     untrusted input (e.g. a future PR-watcher wiring) that must never fall
 *     back to unsandboxed execution silently.
 *
 * `cwd` defaults to `Deno.cwd()` (matching how the two runCli call sites
 * already resolve cwd) so the `CWD` param always has a concrete value even
 * when the caller omits one.
 *
 * `sandboxExecPath` (Darwin) and `bwrapPath` (Linux, defaulting to
 * {@link BWRAP_PATH}) each default to the real system binary and exist as
 * parameters purely so unit tests can point at a nonexistent path to
 * exercise the warn-and-degrade / fail-closed branches deterministically on
 * any machine without mocking `Deno.build.os` or the filesystem.
 */
export function wrapWithSandbox(
  cmd: string[],
  cwd: string | undefined,
  sandbox: SandboxConfig,
  logger?: MethodContext["logger"],
  sandboxExecPath = "/usr/bin/sandbox-exec",
  bwrapPath = BWRAP_PATH,
): string[] {
  if (sandbox.mode === "off") return cmd;

  const isFile = (p: string): boolean => {
    try {
      return Deno.statSync(p).isFile;
    } catch {
      return false;
    }
  };

  const isDarwin = Deno.build.os === "darwin";
  const isLinux = Deno.build.os === "linux";
  const resolvedCwd = cwd ?? Deno.cwd();
  const home = Deno.env.get("HOME") ?? "";

  const backend = resolveEffectiveBackend(sandbox.mode, Deno.build.os);

  if (backend === "seatbelt") {
    if (!isDarwin) {
      return degradeOrThrow(
        `seatbelt requested but platform is ${Deno.build.os}, not darwin`,
        sandbox,
        logger,
        cmd,
      );
    }
    if (!isFile(sandboxExecPath)) {
      return degradeOrThrow(
        `${sandboxExecPath} not found`,
        sandbox,
        logger,
        cmd,
      );
    }
    return [
      sandboxExecPath,
      "-f",
      sandbox.profilePath,
      "-D",
      `CWD=${resolvedCwd}`,
      "-D",
      `HOME=${home}`,
      ...cmd,
    ];
  }

  if (backend === "bwrap") {
    if (!isLinux) {
      return degradeOrThrow(
        `bwrap requested but platform is ${Deno.build.os}, not linux`,
        sandbox,
        logger,
        cmd,
      );
    }
    if (!isFile(bwrapPath)) {
      return degradeOrThrow(`${bwrapPath} not found`, sandbox, logger, cmd);
    }
    const exists = (p: string): boolean => {
      try {
        Deno.lstatSync(p);
        return true;
      } catch {
        return false;
      }
    };
    return [
      bwrapPath,
      ...buildBwrapArgs(cmd, resolvedCwd, home, exists),
    ];
  }

  return degradeOrThrow(
    `no sandbox backend for platform ${Deno.build.os}`,
    sandbox,
    logger,
    cmd,
  );
}

/**
 * Shared warn-and-degrade / fail-closed fallback for {@link wrapWithSandbox}
 * when the platform's sandbox backend can't be applied (missing binary or
 * unsupported OS). Extracted once both the Darwin and Linux branches needed
 * the identical decision (throw if `sandbox.required`, else warn and return
 * `cmd` unchanged).
 */
function degradeOrThrow(
  reason: string,
  sandbox: SandboxConfig,
  logger: MethodContext["logger"] | undefined,
  cmd: string[],
): string[] {
  if (sandbox.required) {
    throw new Error(
      `a sandbox was requested (sandboxRequired is true) but cannot be applied: ${reason}. Refusing to run unsandboxed.`,
    );
  }
  logger?.warning(
    "Sandbox requested but unavailable ({reason}) — running UNSANDBOXED. Set sandboxRequired=true to fail closed instead.",
    { reason },
  );
  return cmd;
}

/** Swamp control-plane credentials that provider CLI children must not inherit. */
export const PROVIDER_CHILD_ENV_DENYLIST = [
  "SWAMP_WORKER_TOKEN",
  "SWAMP_SERVER_TOKEN",
  "SWAMP_API_KEY",
  "SWAMP_SERVE_EXTRA_HEADERS",
] as const;

/** Return a copy of `env` without Swamp control-plane credentials. */
export function filterProviderChildEnv(
  env: Record<string, string>,
): Record<string, string> {
  const filtered = { ...env };
  for (const name of PROVIDER_CHILD_ENV_DENYLIST) delete filtered[name];
  return filtered;
}

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
 *
 * When `opts.sandbox` is set (mode !== "off"), `cmd` is passed through
 * {@link wrapWithSandbox} first — this is the single choke point every
 * provider CLI spawns through, so the OS-level confinement applies uniformly.
 * The child Deno.Command then becomes `sandbox-exec`, which execs the real
 * CLI as a grandchild; SIGTERM/SIGKILL still target the direct child
 * (sandbox-exec), and the existing `cancelStreams` handling above already
 * tolerates surviving grandchildren holding the pipe open, so no changes were
 * needed to the kill/drain logic below for this to work correctly.
 */
export async function runCli(
  cmd: string[],
  opts: {
    cwd?: string;
    stdin?: string;
    wallTimeoutMs: number;
    idleTimeoutMs?: number;
    sandbox?: SandboxConfig;
    logger?: MethodContext["logger"];
  },
): Promise<CmdResult> {
  const effectiveCmd = opts.sandbox
    ? wrapWithSandbox(cmd, opts.cwd, opts.sandbox, opts.logger)
    : cmd;
  const start = performance.now();
  const command = new Deno.Command(effectiveCmd[0], {
    args: effectiveCmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    stdin: opts.stdin ? "piped" : "null",
    cwd: opts.cwd,
    clearEnv: true,
    env: filterProviderChildEnv(Deno.env.toObject()),
  });

  const child = command.spawn();

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

  // Start drains + watchdog BEFORE writing stdin. Writing a large
  // prompt while the child already emits on stdout/stderr can fill the OS pipe
  // buffers and deadlock if nobody is reading yet.
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

  if (opts.stdin && child.stdin) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }

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

/** Claude tool names allowed per profile, passed to `--allowedTools`. */
const CLAUDE_ALLOWED_TOOLS: Record<ToolProfile, string> = {
  readonly: "Read Grep Glob",
  actor: "Read Grep Glob Edit Write Bash",
};

/**
 * Build the command array for the Claude CLI.
 *
 * `--allowedTools`/`--allowed-tools` is declared variadic (`<tools...>`) by
 * the claude CLI (v2.1.207 confirmed via `claude --help`), meaning it greedily
 * consumes every following argv token — including the trailing prompt
 * positional. Passed as two separate argv entries (`"--allowedTools",
 * "Read Grep Glob"`), claude swallows the prompt into the tools list and then
 * fails with "Input must be provided either through stdin or as a prompt
 * argument when using --print" because no positional prompt remains. Using
 * the `--flag=value` form instead keeps the whole value (including its
 * internal spaces) as a single argv token, so the variadic parser can't reach
 * past it to grab the next argv entry. Verified manually: the equals-form
 * both delivers the prompt AND enforces the allowlist (a disallowed Write
 * call was denied under `--allowedTools="Read Grep Glob"`).
 */
export function buildClaudeCommand(
  cliPath: string,
  model: ModelId,
  resolvedPrompt: string,
  toolProfile: ToolProfile,
): { cmd: string[]; stdin?: string } {
  const cmd = [
    cliPath,
    "--model",
    model,
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "dontAsk",
    "--allowedTools=" + CLAUDE_ALLOWED_TOOLS[toolProfile],
  ];
  cmd.push(resolvedPrompt);
  return { cmd };
}

/** Build the command array for the OpenCode CLI. */
function buildOpencodeCommand(
  cliPath: string,
  model: ModelId,
  resolvedPrompt: string,
  _toolProfile: ToolProfile,
): { cmd: string[]; stdin?: string } {
  return {
    cmd: [cliPath, "run", "--format", "json", "--model", model, resolvedPrompt],
  };
}

/**
 * Amp permission rules per profile, passed via `--settings-file` as JSON
 * pointing at `amp.permissions` rules (amp has no CLI flag for inline rules).
 * Rules are evaluated in order; the trailing catch-all makes the remaining
 * tools allowed-by-default while `reject` rules for dangerous Bash patterns
 * take precedence over it.
 */
const AMP_PERMISSIONS: Record<ToolProfile, unknown[]> = {
  readonly: [
    { tool: "Bash", action: "reject", matches: { cmd: ["*"] } },
    { tool: "edit_file", action: "reject" },
    { tool: "create_file", action: "reject" },
    { tool: "*", action: "allow" },
  ],
  actor: [
    {
      tool: "Bash",
      action: "reject",
      matches: { cmd: ["git push*", "curl*", "rm -rf*"] },
    },
    { tool: "*", action: "allow" },
  ],
};

/**
 * Build the command array for the Amp CLI.
 *
 * `--stream-json` makes amp emit Claude-Code-compatible stream JSON (one event
 * per line) instead of plain text, so token usage can be parsed from the
 * `assistant` events. The prompt is fed on stdin in execute mode (`-x`).
 *
 * Amp has no CLI flag for inline permission rules (only `amp.permissions` in
 * a settings file, see `amp permissions --help`), so the profile's rules are
 * written to a temp settings file passed via `--settings-file`. This replaces
 * `--dangerously-allow-all`: instead of a blanket bypass, Bash is scoped to
 * reject `git push`, `curl`, and `rm -rf` (actor profile) or rejected entirely
 * alongside file edits (readonly profile), with everything else allowed.
 */
async function buildAmpCommand(
  cliPath: string,
  _model: ModelId,
  resolvedPrompt: string,
  toolProfile: ToolProfile,
): Promise<{ cmd: string[]; stdin?: string }> {
  const settingsFile = await Deno.makeTempFile({
    prefix: "amp-settings-",
    suffix: ".json",
  });
  await Deno.writeTextFile(
    settingsFile,
    JSON.stringify({ "amp.permissions": AMP_PERMISSIONS[toolProfile] }),
  );
  return {
    cmd: [
      cliPath,
      "--settings-file",
      settingsFile,
      "-x",
      "--stream-json",
    ],
    stdin: resolvedPrompt,
  };
}

/** Gemini approval mode per profile: read-only tools only vs. auto-approve all. */
const GEMINI_APPROVAL_MODE: Record<ToolProfile, string> = {
  readonly: "plan",
  actor: "yolo",
};

/** Build the command array for the Gemini CLI. */
function buildGeminiCommand(
  cliPath: string,
  model: ModelId,
  resolvedPrompt: string,
  toolProfile: ToolProfile,
): { cmd: string[]; stdin?: string } {
  return {
    cmd: [
      cliPath,
      "-p",
      resolvedPrompt,
      "-m",
      model,
      "--approval-mode",
      GEMINI_APPROVAL_MODE[toolProfile],
      "-o",
      "json",
    ],
  };
}

/**
 * Codex sandbox policy per profile, passed via `--sandbox`/`-s`.
 * "readonly" disallows all file writes and shell command execution beyond
 * reads; "actor" allows writes scoped to the workspace (no full-disk access).
 */
const CODEX_SANDBOX_MODE: Record<ToolProfile, string> = {
  readonly: "read-only",
  actor: "workspace-write",
};

/**
 * Build the command array for the OpenAI Codex CLI.
 *
 * `codex exec --json` runs non-interactively and emits one JSON event per line
 * (JSONL). The prompt is the final positional argument — codex reads from stdin
 * only when no prompt arg is given, so we must NOT pipe it on stdin. `--color
 * never` keeps ANSI codes out of the captured stream.
 *
 * `--skip-git-repo-check` disables codex's per-directory trust gate. Without it,
 * codex refuses to run from any cwd not marked `trust_level = "trusted"` in
 * `~/.codex/config.toml` — printing a plain-text refusal ("Not inside a trusted
 * directory and --skip-git-repo-check was not specified.") to stdout INSTEAD of
 * the JSONL stream. That refusal then breaks any downstream JSON parse (e.g.
 * invokeAndParse). Batch/non-interactive callers legitimately run from arbitrary
 * working directories (nested `swamp model method run` inherits whatever cwd the
 * parent had), so the trust gate is inappropriate here — we always skip it.
 *
 * That trust-gate skip is paired with a real sandbox so it isn't a blanket
 * bypass: `--sandbox` scopes filesystem/network access per profile (read-only
 * vs workspace-write, never danger-full-access), and `-c approval_policy=never`
 * keeps the run non-interactive (no TTY is available to answer a prompt in
 * batch/nested invocation) rather than disabling confirmation via
 * `--dangerously-bypass-approvals-and-sandbox`.
 */
function buildCodexCommand(
  cliPath: string,
  model: ModelId,
  resolvedPrompt: string,
  toolProfile: ToolProfile,
): { cmd: string[]; stdin?: string } {
  return {
    cmd: [
      cliPath,
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--sandbox",
      CODEX_SANDBOX_MODE[toolProfile],
      "-c",
      "approval_policy=never",
      "-m",
      model,
      resolvedPrompt,
    ],
  };
}

/**
 * Grok sandbox profile per tool profile, passed via `--sandbox`.
 * "readonly" is the CLI's `read-only` profile (writes confined to `~/.grok/`
 * and tmp, child network blocked). "actor" is `workspace` (writes confined to
 * cwd/tmp/`~/.grok/`, not full-disk `devbox`/`off`).
 */
const GROK_SANDBOX_MODE: Record<ToolProfile, string> = {
  readonly: "read-only",
  actor: "workspace",
};

/**
 * Grok permission-mode + extra flags per tool profile.
 *
 * "readonly" uses `dontAsk`, which silently denies anything not explicitly
 * allowed — combined with the `read-only` sandbox above, no write or shell
 * exec can slip through non-interactively.
 *
 * "actor" needs a non-interactive-safe execute mode: `ask`/`acceptEdits`
 * would stall forever waiting on a TTY prompt for shell commands (there is
 * none in a batch/nested invocation), so this uses `always-approve` — but,
 * mirroring Amp's actor profile, pairs it with explicit `--deny` rules for
 * the same dangerous Bash patterns (git push, curl, rm -rf) rather than
 * leaving a blanket bypass. The `workspace` sandbox above is the primary
 * boundary; the deny rules are defense in depth on top of it.
 */
const GROK_PERMISSION_ARGS: Record<ToolProfile, string[]> = {
  readonly: ["--permission-mode", "dontAsk"],
  actor: [
    "--permission-mode",
    "always-approve",
    "--deny",
    "Bash(git push*)",
    "--deny",
    "Bash(curl*)",
    "--deny",
    "Bash(rm -rf*)",
  ],
};

/**
 * Build the command array for the xAI Grok Build CLI.
 *
 * Headless mode (`-p`) prints to stdout and exits. We use `--output-format
 * streaming-json` so the idle-timeout watchdog sees progress during long tool
 * runs (a single end-of-run `json` blob would look idle).
 *
 * This replaces the prior `--always-approve` + `--permission-mode
 * bypassPermissions` blanket bypass with `--sandbox` (GROK_SANDBOX_MODE) as
 * the primary boundary and profile-scoped `--permission-mode`/`--deny` flags
 * (GROK_PERMISSION_ARGS) — see both consts above for the per-profile
 * rationale. No bypass flag is passed for either profile.
 *
 * Always pass `-m`: callers using Grok must set `model` / `defaultModel` to a
 * Grok id (e.g. `grok-4.5`). Do not pass Claude defaults like `opus`.
 *
 * Exported for unit tests that assert the exact argv contract.
 */
export function buildGrokCommand(
  cliPath: string,
  model: ModelId,
  resolvedPrompt: string,
  toolProfile: ToolProfile,
): { cmd: string[]; stdin?: string } {
  return {
    cmd: [
      cliPath,
      "-p",
      resolvedPrompt,
      "-m",
      model,
      "--output-format",
      "streaming-json",
      "--sandbox",
      GROK_SANDBOX_MODE[toolProfile],
      ...GROK_PERMISSION_ARGS[toolProfile],
    ],
  };
}

/**
 * Parse `grok models` human-readable stdout into bare model ids.
 *
 * Real capture shape:
 * ```
 * You are logged in with grok.com.
 * Default model: grok-4.5
 * Available models:
 *   * grok-4.5 (default)
 *   - grok-composer-2.5-fast
 * ```
 * Strips bullets (`*` / `-` / `•`), optional `(default)` suffix, headers, and
 * blanks. Returns `[]` only when no bullet lines are present — callers that
 * need to distinguish format drift from an empty catalog should check whether
 * stdout looked non-empty (see listModels).
 */
export function parseGrokModelsList(stdout: string): ModelId[] {
  const models: ModelId[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Bullet lines: `* id (default)`, `- id`, or `• id` (unicode bullet).
    const m = line.match(/^[*\-\u2022]\s+(\S+)/);
    if (!m) continue;
    let id = m[1];
    // Drop a trailing `(default)` glued without space (defensive); the capture
    // has a space before `(default)` so `\S+` already excludes it.
    id = id.replace(/\(default\)$/i, "").replace(/,$/, "");
    if (id) models.push(id);
  }
  return models;
}

function assertNever(x: never): never {
  throw new Error(`unexpected provider: ${String(x)}`);
}

/**
 * Provider-typed text extraction (wire shapes). Called only via PROVIDERS
 * adapter methods so call sites never switch on provider strings.
 */
function extractTextImpl(provider: Provider, rawOutput: string): string {
  switch (provider) {
    case "claude": {
      for (const line of rawOutput.split("\n").reverse()) {
        try {
          const event = JSON.parse(line);
          if (event.type === "result") return event.result || rawOutput;
        } catch { /* not JSON */ }
      }
      return rawOutput;
    }
    case "opencode": {
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
      const err = extractErrorImpl(provider, rawOutput);
      return err ? err.message : rawOutput;
    }
    case "amp": {
      for (const line of rawOutput.split("\n").reverse()) {
        try {
          const event = JSON.parse(line);
          if (event.type === "result") return event.result || rawOutput;
        } catch { /* not JSON */ }
      }
      return rawOutput;
    }
    case "gemini": {
      try {
        const data = JSON.parse(rawOutput);
        return data.response || rawOutput;
      } catch {
        return rawOutput;
      }
    }
    case "codex": {
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
      const err = extractErrorImpl(provider, rawOutput);
      return err ? err.message : rawOutput;
    }
    case "grok": {
      const parts: string[] = [];
      for (const line of rawOutput.split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "text" && typeof event.data === "string") {
            parts.push(event.data);
          }
        } catch { /* not JSON */ }
      }
      if (parts.length > 0) return parts.join("");
      const err = extractErrorImpl(provider, rawOutput);
      return err ? err.message : rawOutput;
    }
    default:
      return assertNever(provider);
  }
}

/** Public extractor — dispatches through the closed PROVIDERS adapter. */
export function extractTextFromOutput(
  provider: string,
  rawOutput: string,
): string {
  if (!isProvider(provider)) return rawOutput;
  return PROVIDERS[provider].extractText(rawOutput);
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

/**
 * Failure classification taxonomy for a persisted invocation result.
 *
 * These values are a stable contract consumed downstream — notably the
 * software-factory `frink-runtime` `decideProviderFallback` (FRK-AGENT-002),
 * whose provider-fallback gate advances a role's tier ONLY on the two
 * throttling classes (`rate-limit`, `session-limit`) and treats the rest as
 * non-fallback signals. Keep the string values EXACTLY in sync with that
 * consumer's closed signal-class universe. Successful invocations carry no
 * class (the field is omitted).
 */
export type FailureClass =
  | "rate-limit"
  | "session-limit"
  | "contract-violation"
  | "agent-declined"
  | "infrastructure"
  | "unknown";

/**
 * Versioned signature table for the failure classifier. Bump SIGNATURE_TABLE
 * .version when the substring sets change so downstream telemetry can tell
 * which revision classified a given record.
 *
 * Signature-set provenance (do not invent — grounded in this repo's observed
 * captures and the retryable-error heuristics):
 *
 * - `rateLimit`: transient throttling the provider expects you to retry —
 *   HTTP 429 / "rate limit" / "too many requests" / server "overloaded".
 *   Codex and Claude/Gemini surface these; see extractError + the *_RATE_LIMIT
 *   fixtures in cli_agent_test.ts.
 * - `sessionLimit`: quota / plan / session exhaustion that a retry cannot cure
 *   within the window — opencode's real capture is
 *   `{name:"quota_exceeded", ... "Payment Required: You have exceeded your
 *   monthly quota"}` with `isRetryable:false`. "insufficient_quota" is the
 *   OpenAI-family quota-exhaustion code.
 *
 * EVIDENCE GAP (documented, not invented): the repo's only captured
 * quota/session signatures are the opencode `quota_exceeded` / "payment
 * required" / "insufficient_quota" family — there is no captured, provider-
 * distinct "session limit" wording for claude/amp/gemini/codex/grok. Those
 * providers currently share this combined session-limit set. When live
 * telemetry surfaces a provider-specific session/quota string that today would
 * misclassify (e.g. a Claude "session limit reached" that lands in `unknown`),
 * add it here and bump `version` rather than guessing its exact wording now.
 *
 * Precedence: `rateLimit` is matched BEFORE `sessionLimit` so a message that
 * mentions both (e.g. "429 ... upgrade your quota") is treated as the
 * recoverable throttle. `looksRateLimited` (retryability) unions both sets, so
 * splitting them here does NOT change which errors get retried.
 */
export const SIGNATURE_TABLE: {
  readonly version: string;
  readonly rateLimit: readonly string[];
  readonly sessionLimit: readonly string[];
} = {
  version: "1",
  rateLimit: [
    "rate limit",
    "rate_limit",
    "ratelimit",
    "too many requests",
    "overloaded",
    "429",
  ],
  sessionLimit: [
    "quota",
    "payment required",
    "insufficient_quota",
    "session limit",
    "session_limit",
  ],
};

/** True when `hay` contains any of `sigs` (all lowercased comparison). */
function matchesAny(hay: string, sigs: readonly string[]): boolean {
  return sigs.some((s) => hay.includes(s));
}

/**
 * True when an error message/code looks like a rate-limit OR session/quota
 * exhaustion. Retryability is the union of both throttling signature sets —
 * this preserves the historical retry behavior after the table was split into
 * distinct rate-limit vs session-limit classes.
 */
function looksRateLimited(message: string, code?: string | number): boolean {
  const hay = `${message} ${code ?? ""}`.toLowerCase();
  return matchesAny(hay, SIGNATURE_TABLE.rateLimit) ||
    matchesAny(hay, SIGNATURE_TABLE.sessionLimit);
}

/** Structured inputs the classifier reads to assign a {@link FailureClass}. */
export interface FailureSignal {
  /** Whether the invocation ultimately succeeded. Success carries no class. */
  success: boolean;
  /** Provider error surfaced in the CLI output stream, if any. */
  providerError?: { message?: string; code?: string } | null;
  /** True when the run was killed by a wall/idle timeout. */
  timedOut?: boolean;
  /** Non-zero/kill process exit code, if the process itself failed. */
  exitCode?: number;
  /** True when the CLI exited cleanly but produced no usable answer. */
  cleanExit?: boolean;
  /**
   * True when the output failed a declared schema/parse contract even though
   * the run otherwise succeeded (invokeAndParse's JSON requirement).
   */
  contractViolation?: boolean;
}

/**
 * Deterministically classify a FAILED invocation into a {@link FailureClass}.
 *
 * Pure and table-driven so it is unit-testable and the signature table is the
 * single versioned source of truth. Returns `undefined` for a success (no
 * class is persisted). Classification precedence, highest first:
 *
 * 1. `contract-violation` — declared output contract failed (parse/schema),
 *    regardless of a clean process exit (invokeAndParse).
 * 2. `rate-limit` / `session-limit` — provider-reported throttling, split by
 *    the {@link SIGNATURE_TABLE}; rate-limit wins a tie.
 * 3. `infrastructure` — timeout, spawn/sandbox/exit failure with no provider
 *    error (the process, not the model, failed).
 * 4. `agent-declined` — clean process exit but `success:false` and no other
 *    signal (the agent ran but declined / produced no answer).
 * 5. `unknown` — anything else that still failed.
 */
export function classifyFailure(
  signal: FailureSignal,
): FailureClass | undefined {
  if (signal.success) return undefined;

  if (signal.contractViolation) return "contract-violation";

  const err = signal.providerError;
  if (err) {
    const hay = `${err.message ?? ""} ${err.code ?? ""}`.toLowerCase();
    if (matchesAny(hay, SIGNATURE_TABLE.rateLimit)) return "rate-limit";
    if (matchesAny(hay, SIGNATURE_TABLE.sessionLimit)) return "session-limit";
    // A provider surfaced an error we can't bucket as throttling: it's a
    // provider/agent-side failure, not host infrastructure.
    return "unknown";
  }

  if (
    signal.timedOut ||
    (signal.exitCode !== undefined && signal.exitCode !== 0 &&
      !signal.cleanExit)
  ) {
    return "infrastructure";
  }

  // Clean process exit (or exit 0) but the invocation still failed and no
  // provider error was surfaced: the agent ran and declined / gave no answer.
  if (signal.cleanExit || signal.exitCode === 0) return "agent-declined";

  return "unknown";
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
 * - `grok`: a `{type:"error", message}` event (JSONL streaming-json or a
 *   single JSON document). Grok often exits 0 on failure and may mirror a
 *   plain-text Error line on stderr; callers pass combined stdout+stderr so
 *   either channel is seen. Plain `Error:` lines only count when the run
 *   produced no text chunks (benign stderr noise on a successful run is not a
 *   failure). Unknown-model messages are non-retryable.
 */
function extractErrorImpl(
  provider: Provider,
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

  if (provider === "grok") {
    // Grok frequently exits 0 on failure. Errors appear as:
    // 1) JSON `{type:"error", message}` on stdout (streaming-json / json), and/or
    // 2) a plain `Error: …` line on stderr.
    // Callers pass combined stdout+stderr. Prefer structured JSON when present;
    // fall back to plain Error: lines so stderr-only exit-0 cases cannot
    // silent-succeed.
    const tryParseJson = (s: string): ProviderError | null => {
      try {
        const event = JSON.parse(s);
        if (event.type !== "error") return null;
        const message: string = typeof event.message === "string"
          ? event.message
          : "grok reported an error";
        return {
          message,
          code: undefined,
          // unknown model id / invalid params are permanent; rate limits retry.
          retryable: looksRateLimited(message),
        };
      } catch {
        return null;
      }
    };
    const tryPlainError = (line: string): ProviderError | null => {
      const trimmed = line.trim();
      // Match `Error: …` (Grok CLI) and `error: …` variants; require a body.
      const m = trimmed.match(/^error:\s+(.+)$/i);
      if (!m) return null;
      const message = m[1].trim();
      if (!message) return null;
      return {
        message,
        code: undefined,
        retryable: looksRateLimited(message),
      };
    };
    for (const line of rawOutput.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("{")) {
        const err = tryParseJson(trimmed);
        if (err) return err;
      }
    }
    // Single-document fallback (non-streaming json format).
    const whole = tryParseJson(rawOutput.trim());
    if (whole) return whole;
    // Plain-text stderr-only path (after JSON scan so JSON wins when both
    // exist). Only when the run produced no assistant text: a successful run
    // can carry benign stderr noise (update checks, telemetry) that matches
    // `Error: …`, and must not be reported as a provider failure.
    const producedText = rawOutput.split("\n").some((line) => {
      try {
        const event = JSON.parse(line);
        return event.type === "text" && typeof event.data === "string";
      } catch {
        return false;
      }
    });
    if (producedText) return null;
    for (const line of rawOutput.split("\n")) {
      const err = tryPlainError(line);
      if (err) return err;
    }
    return null;
  }

  // Compile-time exhaustiveness: a new ProviderEnum member fails to narrow to
  // `never` here until a branch above handles it.
  return assertNever(provider);
}

/** Public error extractor — dispatches through PROVIDERS. */
export function extractError(
  provider: string,
  rawOutput: string,
): ProviderError | null {
  if (!isProvider(provider)) return null;
  return PROVIDERS[provider].extractError(rawOutput);
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
 * - `grok`: headless streaming-json / json currently emit no token or cost
 *   fields on stdout. Return {}. Do not scrape `~/.grok/sessions`.
 */
function extractUsageImpl(provider: Provider, rawOutput: string): UsageData {
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

  if (provider === "grok") {
    // Headless stdout has no usage/cost fields today.
    return {};
  }

  return assertNever(provider);
}

/** Public usage extractor — dispatches through PROVIDERS. */
export function extractUsage(provider: string, rawOutput: string): UsageData {
  if (!isProvider(provider)) return {};
  return PROVIDERS[provider].extractUsage(rawOutput);
}

/** A scoped permission profile applied to a provider's CLI invocation. */
type ToolProfile = "readonly" | "actor";

/** A command-builder for a provider's CLI. */
type CommandBuilder = (
  cliPath: string,
  model: ModelId,
  resolvedPrompt: string,
  toolProfile: ToolProfile,
) =>
  | { cmd: string[]; stdin?: string }
  | Promise<{ cmd: string[]; stdin?: string }>;

/**
 * Closed per-provider capability record.
 *
 * Adding a provider means extending ProviderEnum **and** this registry (and the
 * pure extract* cases that each adapter method calls) — TypeScript exhaustiveness
 * on the extract switches forces wire-shape handlers to stay in sync.
 */
type ProviderCapabilities = {
  buildCommand: CommandBuilder;
  cliPath: (g: GlobalArgs) => string;
  /**
   * Suggested model when the global default is still the unconfigured Claude
   * schema default (`opus`) and this provider is not Claude (see resolveModel).
   */
  defaultModel?: ModelId;
  /**
   * When true, extractError / extractText see stdout+stderr combined so
   * stderr-only exit-0 failures cannot silent-succeed (Grok).
   */
  combineStreams: boolean;
  /**
   * When set, listModels is supported: run `<cliPath> models` and parse stdout.
   * Absent → listModels rejects that provider.
   */
  parseModelsList?: (stdout: string) => ModelId[];
  extractText: (raw: string) => string;
  extractError: (raw: string) => ProviderError | null;
  extractUsage: (raw: string) => UsageData;
};

/**
 * Schema-level default for `defaultModel` on GlobalArgsSchema (Claude-first
 * installs). Used by resolveModel to detect "user never set a model default".
 */
export const CLAUDE_SCHEMA_DEFAULT_MODEL: ModelId = "opus";

/** Exhaustive provider registry — TypeScript errors if a Provider is missing. */
export const PROVIDERS: Record<Provider, ProviderCapabilities> = {
  claude: {
    buildCommand: buildClaudeCommand,
    cliPath: (g) => g.claudePath,
    defaultModel: "opus",
    combineStreams: false,
    extractText: (raw) => extractTextImpl("claude", raw),
    extractError: (raw) => extractErrorImpl("claude", raw),
    extractUsage: (raw) => extractUsageImpl("claude", raw),
  },
  opencode: {
    buildCommand: buildOpencodeCommand,
    cliPath: (g) => g.opencodePath,
    combineStreams: false,
    parseModelsList: (stdout) =>
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    extractText: (raw) => extractTextImpl("opencode", raw),
    extractError: (raw) => extractErrorImpl("opencode", raw),
    extractUsage: (raw) => extractUsageImpl("opencode", raw),
  },
  amp: {
    buildCommand: buildAmpCommand,
    cliPath: (g) => g.ampPath,
    combineStreams: false,
    extractText: (raw) => extractTextImpl("amp", raw),
    extractError: (raw) => extractErrorImpl("amp", raw),
    extractUsage: (raw) => extractUsageImpl("amp", raw),
  },
  gemini: {
    buildCommand: buildGeminiCommand,
    cliPath: (g) => g.geminiPath,
    combineStreams: false,
    extractText: (raw) => extractTextImpl("gemini", raw),
    extractError: (raw) => extractErrorImpl("gemini", raw),
    extractUsage: (raw) => extractUsageImpl("gemini", raw),
  },
  codex: {
    buildCommand: buildCodexCommand,
    cliPath: (g) => g.codexPath,
    combineStreams: false,
    extractText: (raw) => extractTextImpl("codex", raw),
    extractError: (raw) => extractErrorImpl("codex", raw),
    extractUsage: (raw) => extractUsageImpl("codex", raw),
  },
  grok: {
    buildCommand: buildGrokCommand,
    cliPath: (g) => g.grokPath,
    defaultModel: "grok-4.5",
    combineStreams: true,
    parseModelsList: parseGrokModelsList,
    extractText: (raw) => extractTextImpl("grok", raw),
    extractError: (raw) => extractErrorImpl("grok", raw),
    extractUsage: (raw) => extractUsageImpl("grok", raw),
  },
};

/**
 * List providers from the closed PROVIDERS registry (pure; no CLI).
 *
 * Prefer this over scraping JSON Schema when agents or scripts need a typed
 * catalog of what this installed extension version supports.
 */
export function listProvidersFromRegistry(): ProviderInfo[] {
  return (Object.keys(PROVIDERS) as Provider[])
    .sort()
    .map((id) => {
      const caps = PROVIDERS[id];
      const info: ProviderInfo = {
        id,
        supportsListModels: caps.parseModelsList !== undefined,
      };
      if (caps.defaultModel !== undefined) {
        info.defaultModel = caps.defaultModel;
      }
      return info;
    });
}

/**
 * Resolve the model id for an invocation.
 *
 * Priority:
 * 1. explicit method arg
 * 2. configured global `defaultModel` (user/instance config always wins when set
 *    to something other than the unconfigured Claude schema default)
 * 3. provider registry default — only when global is still `"opus"` and the
 *    active provider is not Claude (so `defaultProvider: grok` does not
 *    silently run Claude's model)
 */
export function resolveModel(
  provider: Provider,
  explicit: ModelId | undefined,
  globalDefault: ModelId,
): ModelId {
  // Treat omit / "" / whitespace as "no explicit" (schema also rejects blanks).
  if (isPresentModelId(explicit)) return explicit.trim();
  const providerDefault = PROVIDERS[provider].defaultModel;
  if (
    provider !== "claude" &&
    globalDefault === CLAUDE_SCHEMA_DEFAULT_MODEL &&
    providerDefault
  ) {
    return providerDefault;
  }
  return globalDefault;
}

function cliPathFor(provider: Provider, g: GlobalArgs): string {
  return PROVIDERS[provider].cliPath(g);
}

/**
 * Build a {@link SandboxConfig} from global args, with optional per-invocation
 * overrides (mirrors how `toolProfile` is threaded: global default, overridable
 * per call).
 *
 * `resolveDefaultProfile` supplies the path to the shipped `.sb` when the caller
 * has NOT set a `sandboxProfile` override. It is invoked lazily — only when the
 * EFFECTIVE backend (via {@link resolveEffectiveBackend}, using the CURRENT
 * `Deno.build.os`) is seatbelt, i.e. `mode: "seatbelt"` explicitly, or
 * `mode: "auto"` while running on Darwin — without an override. This keeps
 * `off`, explicit `bwrap`, and `auto` on Linux (or any non-Darwin OS) from ever
 * touching the filesystem for a profile bwrap doesn't use, and from risking a
 * throw when the profile can't be resolved. Production passes
 * `() => ctx.extensionFile(SANDBOX_PROFILE_FILENAME)`; tests inject a stub so
 * resolution can be exercised against a simulated pulled layout without a full
 * model runtime.
 */
export function sandboxConfigFrom(
  g: GlobalArgs,
  resolveDefaultProfile: () => string,
  overrides?: {
    sandboxMode?: "off" | "auto" | "seatbelt" | "bwrap";
    sandboxRequired?: boolean;
  },
): SandboxConfig {
  const mode = overrides?.sandboxMode ?? g.sandboxMode;
  const needsProfile = resolveEffectiveBackend(mode, Deno.build.os) ===
    "seatbelt";
  const profilePath = g.sandboxProfile ??
    (needsProfile ? resolveDefaultProfile() : "");
  return {
    mode,
    profilePath,
    required: overrides?.sandboxRequired ?? g.sandboxRequired,
  };
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
  toolProfile: ToolProfile,
  opts: {
    cwd: string;
    wallTimeoutMs: number;
    idleTimeoutMs: number;
    maxRetries: number;
    sandbox?: SandboxConfig;
  },
  logger?: MethodContext["logger"],
): Promise<RunOutcome> {
  const caps = PROVIDERS[provider];
  const buildCommand = caps.buildCommand;
  let lastResult: CmdResult | undefined;
  let providerError: ProviderError | null = null;
  let retries = 0;

  while (retries <= opts.maxRetries) {
    const { cmd, stdin } = await buildCommand(
      cliPath,
      modelName,
      resolved,
      toolProfile,
    );
    lastResult = await runCli(cmd, {
      cwd: opts.cwd,
      stdin,
      wallTimeoutMs: opts.wallTimeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs,
      sandbox: opts.sandbox,
      logger,
    });
    // combineStreams (Grok): scan stdout+stderr so stderr-only exit-0 errors
    // cannot silent-succeed. Policy lives on the provider registry.
    const errorSource = caps.combineStreams
      ? [lastResult.stdout, lastResult.stderr].filter(Boolean).join("\n")
      : lastResult.stdout;
    providerError = caps.extractError(errorSource);

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
  const textSource = caps.combineStreams
    ? [result.stdout, result.stderr].filter(Boolean).join("\n")
    : result.stdout;
  let extractedText = caps.extractText(textSource);
  // When a provider error was detected but extractors left an empty preview,
  // surface the human message for transcripts/outputPreview.
  if (providerError && !extractedText.trim()) {
    extractedText = providerError.message;
  }
  const usage = caps.extractUsage(result.stdout);
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
    promptTruncated: args.prompt.length > 500,
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
    // Deterministic typed failure class (absent on success). invokeAndParse
    // layers `contract-violation` on top when a clean run failed the JSON
    // contract; see its handler.
    failureClass: classifyFailure({
      success: outcome.ok,
      providerError,
      timedOut: result.timedOut,
      exitCode: result.code,
      cleanExit: result.success,
    }),
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
  /**
   * Resolve a manifest-relative bundled file (an `additionalFiles`/`binaries`
   * entry) to an absolute on-disk path. Swamp injects this; it resolves against
   * the extension's files root — `<ext>/files/` when pulled, the source dir in
   * dev/test — so the same relPath works in both layouts. Used to locate the
   * shipped Seatbelt profile ({@link SANDBOX_PROFILE_FILENAME}).
   */
  extensionFile: (relPath: string) => string;
};

/**
 * Swamp model definition for `@mgreten/cli-agent`.
 *
 * Provides four methods:
 * - `invoke` — run a CLI agent and record structured results
 * - `invokeAndParse` — run a CLI agent and parse JSON from the output
 * - `listProviders` — list providers from the closed PROVIDERS registry
 * - `listModels` — enumerate the models available to a provider's CLI
 */
/** Shared invoke / invokeAndParse argument schema (single source for both). */
const InvokeArgsSchema = z.object({
  prompt: z.string().describe("The prompt or slash command to execute"),
  provider: ProviderEnum.optional().describe(
    "Override the default provider",
  ),
  model: ModelIdSchema.optional().describe(
    "Override the default model. When omitted, uses the provider's defaultModel " +
      "from PROVIDERS, then global defaultModel.",
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
  toolProfile: ToolProfileEnum.optional().describe(
    "Scoped permission profile: 'readonly' (read/search only) or 'actor' (also edit/write/run shell). Defaults to defaultToolProfile.",
  ),
  sandboxMode: SandboxModeEnum.optional().describe(
    "Override the global sandboxMode for this invocation: 'auto' (default; OS-picked backend), 'off', 'seatbelt', or 'bwrap'.",
  ),
  sandboxRequired: z.boolean().optional().describe(
    "Override the global sandboxRequired for this invocation: fail closed instead of warn-and-degrade when the sandbox can't be applied.",
  ),
});
type InvokeArgs = z.infer<typeof InvokeArgsSchema>;

const ListModelsArgsSchema = z.object({
  provider: ProviderEnum.optional().describe(
    "Provider to enumerate (defaults to the configured defaultProvider)",
  ),
});
type ListModelsArgs = z.infer<typeof ListModelsArgsSchema>;

const ListProvidersArgsSchema = z.object({});
type ListProvidersArgs = z.infer<typeof ListProvidersArgsSchema>;

export const model = {
  type: "@mgreten/cli-agent",
  version: "2026.07.18.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.07.17.1",
      description:
        "Harden provider child environments; no global argument schema changes",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.18.1",
      description:
        "Add optional typed failureClass to invocation records (additive; existing records without it still parse)",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
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
    providerList: {
      description:
        "CLI providers supported by this extension version (from PROVIDERS registry)",
      schema: ProviderListSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    invoke: {
      description:
        "Run a CLI agent tool (claude, opencode, amp, gemini, codex, grok) with a prompt and record structured results",
      arguments: InvokeArgsSchema,
      execute: async (
        args: InvokeArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const provider = args.provider ?? context.globalArgs.defaultProvider;
        const modelName = resolveModel(
          provider,
          args.model,
          context.globalArgs.defaultModel,
        );
        const cwd = args.cwd || Deno.cwd();
        const wallTimeoutMs = args.wallTimeoutMs ||
          context.globalArgs.wallTimeoutMs;
        const idleTimeoutMs = context.globalArgs.idleTimeoutMs;
        const maxRetries = context.globalArgs.maxRetries;
        const commandsDir = context.globalArgs.commandsDir;
        const commandSubdirs = context.globalArgs.commandSubdirs;
        const toolProfile = args.toolProfile ||
          context.globalArgs.defaultToolProfile;

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
          toolProfile,
          {
            cwd,
            wallTimeoutMs,
            idleTimeoutMs,
            maxRetries,
            sandbox: sandboxConfigFrom(
              context.globalArgs,
              () => context.extensionFile(SANDBOX_PROFILE_FILENAME),
              {
                sandboxMode: args.sandboxMode,
                sandboxRequired: args.sandboxRequired,
              },
            ),
          },
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
      arguments: InvokeArgsSchema,
      execute: async (
        args: InvokeArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const provider = args.provider ?? context.globalArgs.defaultProvider;
        const modelName = resolveModel(
          provider,
          args.model,
          context.globalArgs.defaultModel,
        );
        const cwd = args.cwd || Deno.cwd();
        const wallTimeoutMs = args.wallTimeoutMs ||
          context.globalArgs.wallTimeoutMs;
        const idleTimeoutMs = context.globalArgs.idleTimeoutMs;
        const maxRetries = context.globalArgs.maxRetries;
        const commandsDir = context.globalArgs.commandsDir;
        const commandSubdirs = context.globalArgs.commandSubdirs;
        const toolProfile = args.toolProfile ||
          context.globalArgs.defaultToolProfile;

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
          toolProfile,
          {
            cwd,
            wallTimeoutMs,
            idleTimeoutMs,
            maxRetries,
            sandbox: sandboxConfigFrom(
              context.globalArgs,
              () => context.extensionFile(SANDBOX_PROFILE_FILENAME),
              {
                sandboxMode: args.sandboxMode,
                sandboxRequired: args.sandboxRequired,
              },
            ),
          },
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
        // invokeAndParse additionally requires a parseable JSON payload. A run
        // that otherwise succeeded but produced no valid JSON is a
        // contract-violation; a run that already failed keeps the base class.
        const parseFailedOnOtherwiseOkRun = outcome.ok && parsedJson === null;
        const base = buildInvocationBase(
          invocationId,
          provider,
          modelName,
          args,
          promptHash,
          slashCommand,
          cwd,
          outcome,
        );
        const invocation = {
          ...base,
          success: outcome.ok && parsedJson !== null,
          failureClass: classifyFailure({
            success: outcome.ok && parsedJson !== null,
            providerError: outcome.providerError,
            timedOut: outcome.result.timedOut,
            exitCode: outcome.result.code,
            cleanExit: outcome.result.success,
            contractViolation: parseFailedOnOtherwiseOkRun,
          }),
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

    listProviders: {
      description:
        "List CLI providers supported by this extension (from the closed PROVIDERS registry). Pure — does not shell out. Use listModels to enumerate model ids for a provider that supports it.",
      arguments: ListProvidersArgsSchema,
      execute: async (
        _args: ListProvidersArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const providers = listProvidersFromRegistry();
        const handle = await context.writeResource(
          "providerList",
          "providers",
          {
            providers,
            count: providers.length,
            listedAt: new Date().toISOString(),
          },
        );

        context.logger.info("{count} providers available", {
          count: providers.length,
        });

        return { dataHandles: [handle] };
      },
    },

    listModels: {
      description:
        "List the model identifiers available to a provider's CLI (any provider with parseModelsList in PROVIDERS — currently opencode and grok). Prefer listProviders to see which providers support enumeration.",
      arguments: ListModelsArgsSchema,
      execute: async (
        args: ListModelsArgs,
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const provider = args.provider ?? context.globalArgs.defaultProvider;
        const caps = PROVIDERS[provider];
        if (!caps.parseModelsList) {
          throw new Error(
            `Model enumeration is not supported for '${provider}' — its CLI has no model-listing command (no parseModelsList in PROVIDERS). Run listProviders to see which providers set supportsListModels, or use a provider that declares one (e.g. opencode, grok).`,
          );
        }

        const cliPath = caps.cliPath(context.globalArgs);
        const result = await runCli(
          [cliPath, "models"],
          {
            wallTimeoutMs: 60_000,
            sandbox: sandboxConfigFrom(
              context.globalArgs,
              () => context.extensionFile(SANDBOX_PROFILE_FILENAME),
            ),
            logger: context.logger,
          },
        );
        if (!result.success) {
          throw new Error(
            `${provider} models failed (exit ${result.code}): ${
              result.stderr.slice(0, 200)
            }`,
          );
        }

        // Same exit-0 provider-error class as invoke: do not treat an
        // empty/error stream as a successful empty catalog.
        const errSource = caps.combineStreams
          ? [result.stdout, result.stderr].filter(Boolean).join("\n")
          : result.stdout;
        const providerError = caps.extractError(errSource);
        if (providerError) {
          throw new Error(
            `${provider} models provider error: ${
              providerError.message.slice(0, 300)
            }`,
          );
        }

        const models = caps.parseModelsList(result.stdout);
        // Non-empty stdout with zero parsed ids is format drift / failure,
        // not a legitimate empty catalog — fail loud instead of persisting [].
        const stdoutLooksSubstantial = result.stdout.trim().length > 0 &&
          /model/i.test(result.stdout);
        if (models.length === 0 && stdoutLooksSubstantial) {
          throw new Error(
            `${provider} models produced no parseable model ids (stdout may have changed format). First 200 chars: ${
              result.stdout.trim().slice(0, 200)
            }`,
          );
        }

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
