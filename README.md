# swamp-cli-agent

[swamp](https://swamp.club) extension `@mgreten/cli-agent` — invoke CLI coding
agents (claude, opencode, amp, gemini, codex, grok) with typed inputs and capture
structured outputs including tokens, cost, duration, retries, and exit code.

## Extension documentation

See [extensions/models/README.md](extensions/models/README.md) for full usage,
method reference, schema details, and configuration options.

## Install

```sh
swamp extension pull @mgreten/cli-agent
```

## Repository layout

```
swamp-cli-agent/
  extensions/
    models/
      cli_agent.ts       # model implementation
      manifest.yaml      # swamp extension manifest
      README.md          # extension documentation
      LICENSE.txt        # MIT license
  README.md              # this file
```

## License

MIT — see [extensions/models/LICENSE.txt](extensions/models/LICENSE.txt).
