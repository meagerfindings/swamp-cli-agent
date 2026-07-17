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
      defaultProvider: claude     # claude | opencode | amp | gemini | codex | grok
      defaultModel: opus          # schema default (Claude-first); see model resolution below
      commandsDir: .claude/commands  # where slash commands live
      wallTimeoutMs: 3600000      # 1 hour wall-clock timeout
      maxRetries: 2               # retry count for transient failures
```

CLI paths (`claudePath`, `opencodePath`, `ampPath`, `geminiPath`, `codexPath`,
`grokPath`) default to the bare binary name, relying on `$PATH` resolution.
Override them if your binaries live in a non-standard location.

**Auth:** each provider CLI must already be installed and authenticated on the
host (this extension only shells out). For Grok Build: run `grok login` or set
`XAI_API_KEY`. Claude / Codex / Gemini / Amp / OpenCode use their own login or
env credentials. Provider subprocesses preserve ordinary environment-based
authentication and configuration, but do not inherit known Swamp control-plane
credential variables from the extension method process.

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
| `provider`      | enum     | no       | Override the default provider                 |
| `model`         | string   | no       | Override the default model                    |
| `cwd`           | string   | no       | Working directory for the CLI                 |
| `tags`          | object   | no       | Key-value tags for grouping/filtering         |
| `wallTimeoutMs` | number   | no       | Override wall timeout in milliseconds         |

### `invokeAndParse`

Run a CLI agent and parse JSON from the output. Looks for JSON in fenced code
blocks or raw `{...}` in the response. Throws if the CLI fails or no valid
JSON is found, but still persists the invocation record for debugging.

```sh
swamp model method run my-agent invokeAndParse \
  --args '{"prompt": "Return a JSON object with keys: status, summary", "provider": "claude"}'
```

Takes the same arguments as `invoke`.

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
| `promptHash`      | string  | Base-36 hash for deduplication           |
| `exitCode`        | number  | Process exit code                        |
| `success`         | boolean | Whether the invocation succeeded         |
| `durationMs`      | number  | Wall-clock duration in milliseconds      |
| `outputBytes`     | number  | Raw output size in bytes                 |
| `outputPreview`   | string  | First 1000 chars of extracted text       |
| `retries`         | number  | How many retries were needed             |
| `tokens`          | object  | Token counts (input, output, cache, etc) |
| `costUsd`         | number  | Estimated cost in USD                    |
| `tags`            | object  | User-supplied key-value tags             |

The `prompt` and `outputPreview` fields are truncated for queryability. The
full untruncated prompt and extracted output are persisted alongside every
invocation as a `transcript` resource named `transcript-<invocationId>`:

```sh
swamp data get my-agent transcript-<invocationId> --json
```

## License

MIT — see [LICENSE.txt](LICENSE.txt) for details.
