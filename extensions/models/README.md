# @mgreten/cli-agent

A multi-provider CLI agent invoker for [swamp](https://swamp.club). Runs
coding-agent CLI tools — Claude Code, OpenCode, Amp, Gemini CLI, OpenAI
Codex CLI, or xAI Grok Build CLI — with typed inputs and captures structured
outputs including token counts, estimated cost, wall-clock duration, exit
codes, and automatic retries on transient failures. Every invocation is
persisted as a swamp resource with a 30-day lifetime and automatic garbage
collection, giving you a queryable history of all agent runs across providers.

## Installation

```sh
swamp extension pull @mgreten/cli-agent
```

Then create a model instance:

```sh
swamp model create my-agent --type @mgreten/cli-agent
```

## Setup

Configure global arguments on the model instance. All have sensible defaults:

```yaml
# .swamp.yaml (or pass via --global-args)
models:
  my-agent:
    type: "@mgreten/cli-agent"
    globalArgs:
      defaultProvider: claude     # claude | opencode | amp | gemini | codex | grok | pi
      defaultModel: opus          # schema default (Claude-first); see model resolution below
      commandsDir: .claude/commands  # where slash commands live
      wallTimeoutMs: 3600000      # 1 hour wall-clock timeout
      maxRetries: 2               # retry count for transient failures
      sandboxCredentialAccess: provider # provider (normal CLI login) | isolated
```

CLI paths (`claudePath`, `opencodePath`, `ampPath`, `geminiPath`, `codexPath`,
`grokPath`, `piPath`) default to the bare binary name, relying on `$PATH` resolution.
Override them if your binaries live in a non-standard location.

**Auth:** each provider CLI must already be installed and authenticated on the
host (this extension only shells out). For Grok Build: run `grok login` or set
`XAI_API_KEY`. Claude / Codex / Gemini / Amp / OpenCode use their own login or
env credentials. On Linux, the default `sandboxCredentialAccess: provider`
exposes only the selected provider's known credential files inside bwrap, so
ordinary Claude, Codex, and OpenCode CLI logins remain usable without exposing
the other providers' credentials. The genuine CLI may update its own credential
file when refreshing OAuth state. Provider tools run inside that same sandbox,
so use `sandboxCredentialAccess: isolated` for untrusted prompts; isolated mode
masks every known credential file and requires environment authentication such
as an API key or Claude's official `CLAUDE_CODE_OAUTH_TOKEN` generated with
`claude setup-token`. This setting controls Linux bwrap only. On macOS, the
existing static Seatbelt policy is unchanged: Claude Code can use its normal
Keychain-backed login while known file-backed credentials remain masked.

On Linux, standard linked Git worktrees are supported under bwrap. The linked
worktree remains the only writable repository path; its external common `.git`
directory is mounted read-only with optional Git locking disabled, allowing
agents to inspect branches, status, and diffs without exposing or mutating the
parent checkout.

For pi, pass the model in `provider/id` form (for example,
`openrouter/moonshotai/kimi-k3`) via `defaultModel` or the `model` argument.
Pi 0.82.0 or newer is required. Pi extensions are always disabled. Sandboxed
pi uses fresh disposable config, cannot read or modify the host's `~/.pi`, and
therefore must authenticate through environment variables such as
`OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY`. Custom providers, file-backed auth,
and user settings require the explicit trust decision `sandboxMode: off`.
Provider subprocesses preserve ordinary environment-based authentication and
configuration, but do not inherit known Swamp control-plane credential
variables from the extension method process.

**Model resolution** when `invoke` omits `model`:

1. explicit `model` argument, else  
2. configured global `defaultModel`, else  
3. only if global is still the unconfigured Claude schema default (`opus`) **and**
   the provider is not Claude — the provider registry default (e.g. Grok →
   `grok-4.5`)

So a user who set `defaultModel: sonnet` always gets sonnet. A config with
`defaultProvider: grok` and an untouched `defaultModel: opus` resolves to
`grok-4.5` instead of silently calling Claude's model. Prefer setting
`defaultModel` explicitly when you change `defaultProvider`.

## Methods

### `invoke`

Run a CLI agent with a prompt and record structured results. The invocation
record captures everything needed for cost tracking and debugging.

```sh
swamp model method run my-agent invoke \
  --args '{"prompt": "Explain this codebase", "provider": "claude", "model": "sonnet"}'

# Grok Build CLI (requires grok on PATH + grok login / XAI_API_KEY)
swamp model method run my-agent invoke \
  --args '{"prompt": "Explain this codebase", "provider": "grok", "model": "grok-4.5"}'
```

Arguments:

| Name            | Type     | Required | Description                                  |
| --------------- | -------- | -------- | -------------------------------------------- |
| `prompt`        | string   | yes      | The prompt or slash command to execute        |
| `invocationId`  | string   | no       | Stable caller-owned identity for at-most-once launch/replay |
| `provider`      | enum     | no       | Override the default provider                 |
| `model`         | string   | no       | Override the default model                    |
| `cwd`           | string   | no       | Working directory for the CLI                 |
| `repositoryExpectation` | object | no | All-or-none preflight identity: attached branch, 40-char HEAD SHA, and 64-char repository state hash |
| `tags`          | object   | no       | Key-value tags for grouping/filtering         |
| `wallTimeoutMs` | number   | no       | Override wall timeout in milliseconds         |
| `idleTimeoutMs` | number   | no       | Override idle timeout independently           |
| `sandboxCredentialAccess` | enum | no | `provider` for selected-provider CLI login (default), or `isolated` to mask all known credential files |

### `invokeAndParse`

Run a CLI agent and parse JSON from the output. Looks for JSON in fenced code
blocks or raw `{...}` in the response. Throws if the CLI fails or no valid
JSON is found after the configured retry budget, but still persists the final
invocation record for debugging. A clean response with malformed or missing
JSON is retried with a focused JSON repair instruction before terminal evidence
is written.

```sh
swamp model method run my-agent invokeAndParse \
  --args '{"prompt": "Return a JSON object with keys: status, summary", "provider": "claude"}'
```

Takes the same arguments as `invoke`.

When `invocationId` is supplied, a durable claim is written before launch. Reuse
with different execution inputs fails; consistent terminal records replay without
launching again, while partial or inconsistent records fail closed. Omitting it
preserves generated-UUID behavior.

`repositoryExpectation` is optional and strict/all-or-none. It may only be
supplied with a caller-owned `invocationId`; generated invocation IDs are rejected
by both `invoke` and `invokeAndParse`. When supplied, the method canonicalizes `cwd` and, under Swamp's per-model method serialization,
on a new launch verifies that it is the Git repository root on the expected
attached branch and 40-character HEAD SHA, and that its 64-character state hash
still matches. For caller-owned IDs this verification occurs after durable claim
persistence and immediately before provider spawn; terminal replay skips it. The
hash is factory-runtime's
`tracked-diff-v1`: SHA-256 over length-framed tracked `git diff --binary
--full-index HEAD --` output plus sorted untracked paths and exact file bytes.
Detached HEADs, Git/read failures, and any mismatch fail before launch. For a
caller-owned `invocationId`, normalized expectations are part of the durable
claim, so changed expectations conflict and exact terminal replay does not spawn.

A successful replay returns no `dataHandles`: method-result handles represent
only artifacts persisted during that execution, and replay persists nothing.
Consumers retrieve the existing deterministic `invocation-<invocationId>` and
`transcript-<invocationId>` resources instead.

CLI-agent launch claims and terminal evidence are retained for 30 days, so this
extension's at-most-once guarantee has that scope. Longer-lived at-most-once
factory prevention is owned by the factory execution claim; retention here is
intentionally not infinite.

### `listProviders`

List the CLI providers this **installed extension version** supports, with
registry defaults and whether `listModels` can enumerate model ids. Pure — does
not shell out. Results are persisted as a `providerList` resource named
`providers`.

```sh
swamp model method run my-agent listProviders
# → attributes.providers: [{ id, defaultModel?, supportsListModels }, ...]
```

Prefer this over hardcoding provider names in downstream docs or tooling. The
JSON Schema enum on `defaultProvider` (`swamp model type describe
@mgreten/cli-agent --json`) is equivalent for validation; this method is the
typed runtime catalog.

### `listModels`

List the model identifiers available to a provider's CLI. Only providers with
`supportsListModels: true` from `listProviders` (currently `opencode` and
`grok`) work — others have no model-listing CLI command. Results are persisted
as a `modelList` resource named `models-<provider>`.

```sh
swamp model method run my-agent listModels --input provider=opencode
swamp model method run my-agent listModels --input provider=grok
```

Arguments:

| Name       | Type | Required | Description                                          |
| ---------- | ---- | -------- | ---------------------------------------------------- |
| `provider` | enum | no       | Provider to enumerate (defaults to `defaultProvider`) |

### `collectLocalUsage`

Aggregate one local calendar day of native token usage from Claude Code
(`~/.claude/projects/**/*.jsonl`), Codex CLI
(`~/.codex/sessions/**/*.jsonl`), and Amp (including archived threads). The
default date is today in the system timezone; both may be selected explicitly:

```sh
swamp model method run my-agent collectLocalUsage \
  --args '{"date":"2026-07-31","timeZone":"America/Denver"}'
```

The stable `local-usage-YYYY-MM-DD` resource contains provider rows in fixed
`claude`, `amp`, `codex` order plus elementwise combined totals. `inputTokens`
is processed input; cache-read/write counts are informational subsets and are
not added to totals a second time. Sessions launched through cli-agent are
already present in these native-client stores. Do **not** add cli-agent
`invocation` resources to this result, or those sessions will be double-counted.

| Name       | Type   | Required | Description |
| ---------- | ------ | -------- | ----------- |
| `date`     | string | no | Local calendar date as `YYYY-MM-DD`; defaults to today |
| `timeZone` | string | no | IANA timezone; defaults to the system timezone |

## How It Works

1. **Slash command resolution** — prompts starting with `/` are resolved
   against markdown files in the configured `commandsDir`. The resolver
   checks `{commandsDir}/{name}.md` and `{commandsDir}/{name-with-slashes}.md`,
   strips YAML frontmatter, and substitutes `$ARGUMENTS`.

2. **Provider dispatch** — each provider has a dedicated command builder that
   maps the prompt and model to the correct CLI flags. Amp receives prompts
   via stdin; others (including Codex via `codex exec --json`, and Grok via
   `grok -p … --output-format streaming-json`) pass the prompt on the argv.
   Interactive agents run with their permission-bypass flag
   (`--dangerously-skip-permissions` for Claude, `--dangerously-allow-all` for
   Amp, `--yolo` for Gemini, `--always-approve` +
   `--permission-mode bypassPermissions` for Grok) since headless invocations
   cannot answer interactive approval prompts — only point this extension at
   working directories you trust it to modify.

3. **Retry logic** — transient failures (exit codes 137, 143 — typically
   OOM-killed or SIGTERM) and retryable provider errors (rate limits) trigger
   automatic retries with exponential backoff. Grok often exits 0 on API
   errors; error events are still detected in the output stream (stdout+stderr
   combined for Grok).

4. **Output extraction** — provider-specific parsers extract human-readable
   text from streaming JSON formats (Claude stream-json, OpenCode JSON lines,
   Gemini JSON envelope, Codex JSONL `agent_message` items, Grok
   streaming-json `type:text` chunks).

5. **Usage tracking** — token counts and cost are extracted from Claude's
   result events. Other providers return usage data as it becomes available
   in their output formats; Codex reports token usage (no cost) on its
   terminal `turn.completed` event. Grok headless output currently reports
   neither tokens nor cost.

## Invocation Resource Schema

Each invocation is persisted with these fields:

| Field             | Type    | Description                              |
| ----------------- | ------- | ---------------------------------------- |
| `invocationId`    | string  | Unique UUID for this invocation          |
| `provider`        | enum    | Which CLI agent was used                 |
| `model`           | string  | Model name passed to the CLI             |
| `prompt`          | string  | First 500 chars of the original prompt   |
| `promptTruncated` | boolean | Whether `prompt` was capped at 500 chars |
| `promptHash`      | string  | SHA-256 of the fully resolved prompt      |
| `exitCode`        | number  | Process exit code                        |
| `success`         | boolean | Whether the invocation succeeded         |
| `durationMs`      | number  | Wall-clock duration in milliseconds      |
| `outputBytes`     | number  | Raw output size in bytes                 |
| `outputPreview`   | string  | First 1000 chars of extracted text       |
| `retries`         | number  | How many retries were needed             |
| `failureClass`    | enum    | Typed failure taxonomy; absent on success |
| `tokens`          | object  | Token counts (input, output, cache, etc) |
| `costUsd`         | number  | Estimated cost in USD                    |
| `tags`            | object  | User-supplied key-value tags             |

### Failure classification (`failureClass`)

Every **failed** invocation is tagged with a deterministic, typed
`failureClass`. Successful invocations omit the field, and records written
before this field existed parse unchanged (it is optional and additive). The
closed taxonomy is:

| Class                | When it is assigned                                          |
| -------------------- | ----------------------------------------------------------- |
| `rate-limit`         | Provider throttling signatures (429, "rate limit", "too many requests", "overloaded") |
| `session-limit`      | Quota / plan / session exhaustion (`quota`, "payment required", `insufficient_quota`) |
| `contract-violation` | Output failed the declared contract (e.g. `invokeAndParse` found no valid JSON) |
| `agent-declined`     | Clean process exit but the invocation still failed (agent produced no answer) |
| `infrastructure`     | Timeout, spawn/sandbox, or non-zero process exit with no provider error |
| `unknown`            | A failure that matched none of the above                     |

Classification is driven by a versioned signature table
(`SIGNATURE_TABLE.version`) and computed by the pure, exported
`classifyFailure` function, so the signatures are unit-tested and extensible.
Only `rate-limit` and `session-limit` are throttling classes that a downstream
provider-fallback gate should act on. Rate-limit and session-limit currently
share the same captured signatures for providers other than opencode; see the
`SIGNATURE_TABLE` comment for the documented evidence gap.

The `prompt` and `outputPreview` fields are truncated for queryability. The
full untruncated prompt and extracted output are persisted alongside every
invocation as a `transcript` resource named `transcript-<invocationId>`:

```sh
swamp data get my-agent transcript-<invocationId> --json
```

## License

MIT — see [LICENSE.txt](LICENSE.txt) for details.
