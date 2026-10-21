# omp-purge

[English](README.md) | [中文](README.zh-CN.md)

Session-scoped system-prompt switch for omp.

`/purge` replaces or trims the host system prompt for the current session. Default is off: after installing, omp behaves exactly as before until you run `/purge on`.

## Install

```bash
omp plugin install github:362663496/omp-purge
```

Pin a release:

```bash
omp plugin install github:362663496/omp-purge#v1.1.1
```

Restart the omp session after installing. If the plugin is disabled:

```text
/plugins enable omp-purge
```

Local source:

```bash
omp plugin install ~/.omp/plugins-src/omp-purge
```

Project scope: clone the repo, then run:

```bash
OMP_PURGE_SRC=/path/to/omp-purge /path/to/omp-purge/scripts/install-project.sh /path/to/project
```

## Commands

| Command | Action |
| --- | --- |
| `/purge` | Toggle on/off for this session |
| `/purge on` / `/purge off` | Explicit switch |
| `/purge status` | Mode, persona source, size, last prompt cut |
| `/purge mode strict\|replace\|append` | Change composition mode |
| `/purge source <path\|embedded>` | Load a persona file or restore the embedded one |

## Modes

| Mode | System prompt sent |
| --- | --- |
| `strict` (default) | Persona + `Current working directory: ...` only |
| `replace` | Persona + host prompt with its identity line and docs pointer removed |
| `append` | Persona + original host prompt unchanged |

`replace` matches exact host lines. If a line is not found, it leaves the prompt untouched instead of guessing.

## How it works

- `before_agent_start` builds the session system prompt from the selected mode.
- `before_provider_request` rewrites the outgoing payload. omp sends the prompt as top-level `instructions`; omp-purge moves it into an `input` developer message so the model treats it as a session-level instruction. Model, provider, and endpoint stay the same.
- State is in memory only. `session_start` resets to off; nothing is written to disk.
- The persona is embedded in `index.ts`. `/purge source` can load a local file; failures roll back to the previous source.

The footer shows `PURGE ON` while active. Print and RPC modes skip the footer.

## Test

```bash
bun test/smoke.test.mjs
```

## License

MIT
