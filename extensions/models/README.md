# @mgreten/cli-agent

A multi-provider CLI agent invoker for [swamp](https://swamp.club). Runs
coding-agent CLI tools — Claude Code, OpenCode, Amp, or Gemini CLI — with
typed inputs and captures structured outputs including token counts, estimated
cost, wall-clock duration, exit codes, and automatic retries on transient
failures. Every invocation is persisted as a swamp resource with a 30-day
lifetime and automatic garbage collection, giving you a queryable history of
all agent runs across providers.

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
      defaultProvider: claude     # claude | opencode | amp | gemini
      defaultModel: opus          # model name passed to the CLI
      commandsDir: .claude/commands  # where slash commands live
      wallTimeoutMs: 3600000      # 1 hour wall-clock timeout
      maxRetries: 2               # retry count for transient failures
```

CLI paths (`claudePath`, `opencodePath`, `ampPath`, `geminiPath`) default to
the bare binary name, relying on `$PATH` resolution. Override them if your
binaries live in a non-standard location.

## Methods

### `invoke`

Run a CLI agent with a prompt and record structured results. The invocation
record captures everything needed for cost tracking and debugging.

```sh
swamp model method run my-agent invoke \
  --args '{"prompt": "Explain this codebase", "provider": "claude", "model": "sonnet"}'
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

### `listModels`

List the model identifiers available to a provider's CLI. Currently supported
for `opencode` only (the other provider CLIs have no model-listing command).
Results are persisted as a `modelList` resource named `models-<provider>`.

```sh
swamp model method run my-agent listModels --input provider=opencode
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
   via stdin; others use positional arguments. All providers run with their
   permission-bypass flag (`--dangerously-skip-permissions` for Claude,
   `--dangerously-allow-all` for Amp, `--yolo` for Gemini) since headless
   invocations cannot answer interactive approval prompts — only point this
   extension at working directories you trust it to modify.

3. **Retry logic** — transient failures (exit codes 137, 143 — typically
   OOM-killed or SIGTERM) trigger automatic retries with exponential backoff.

4. **Output extraction** — provider-specific parsers extract human-readable
   text from streaming JSON formats (Claude stream-json, OpenCode JSON lines,
   Gemini JSON envelope).

5. **Usage tracking** — token counts and cost are extracted from Claude's
   result events. Other providers return usage data as it becomes available
   in their output formats.

## Invocation Resource Schema

Each invocation is persisted with these fields:

| Field           | Type    | Description                              |
| --------------- | ------- | ---------------------------------------- |
| `invocationId`  | string  | Unique UUID for this invocation          |
| `provider`      | enum    | Which CLI agent was used                 |
| `model`         | string  | Model name passed to the CLI             |
| `prompt`        | string  | First 500 chars of the original prompt   |
| `promptHash`    | string  | Base-36 hash for deduplication           |
| `exitCode`      | number  | Process exit code                        |
| `success`       | boolean | Whether the invocation succeeded         |
| `durationMs`    | number  | Wall-clock duration in milliseconds      |
| `outputBytes`   | number  | Raw output size in bytes                 |
| `outputPreview` | string  | First 1000 chars of extracted text       |
| `retries`       | number  | How many retries were needed             |
| `tokens`        | object  | Token counts (input, output, cache, etc) |
| `costUsd`       | number  | Estimated cost in USD                    |
| `tags`          | object  | User-supplied key-value tags             |

The `prompt` and `outputPreview` fields are truncated for queryability. The
full untruncated prompt and extracted output are persisted alongside every
invocation as a `transcript` resource named `transcript-<invocationId>`:

```sh
swamp data get my-agent transcript-<invocationId> --json
```

## License

MIT — see [LICENSE.txt](LICENSE.txt) for details.
