<div align="center">
  <img src="./assets/banner.svg" alt="omp-purge — session-scoped system prompt control" width="100%" />
</div>

<h1 align="center">omp-purge</h1>

<p align="center">
  <strong>OMP jailbreak / prompt-control plugin.</strong><br>
  One switch. No refusals. Anything goes. Works with most mainstream models.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.1.1-58A6FF?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-3FB950?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/omp-18.x-8957E5?style=flat-square" alt="omp 18.x">
  <img src="https://img.shields.io/badge/models-multi--provider-1F6FEB?style=flat-square" alt="Multi-provider">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/github/stars/changjiangi/omp-purge?style=flat-square&logo=github" alt="GitHub stars">
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">中文</a>
</p>

> **Default off.** Installing the plugin does not change omp. Run `/purge on` to activate it for the current session.

## Contents

- [What it is](#what-it-is)
- [Features](#features)
- [Model support](#model-support)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Commands](#commands)
- [Modes](#modes)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Sponsor](#sponsor)
- [Development](#development)
- [License](#license)

---

## What it is

`omp-purge` is a session-level switch for the system prompt omp sends to the model.

It can replace the host prompt with an embedded persona, trim the host identity out of the prompt, or append the persona on top of the original prompt. The change applies only to the current session. `/purge off` restores the original behavior immediately.

It is built for prompt engineering and instruction-following experiments:

- compare full host prompt vs. trimmed prompt vs. persona-only prompt
- test how much host identity affects model behavior
- run the same request against multiple providers with the same injected prompt
- load your own persona file without editing the plugin

The plugin changes prompt composition only. It does not change the selected model, provider, base URL, credentials, or tool set.

## Features

| Feature | What it does |
| --- | --- |
| Session switch | `/purge on` / `/purge off`; a new session starts off |
| Three modes | `strict`, `replace`, `append` |
| Embedded persona | Works out of the box; no external file required |
| External persona | `/purge source <path>` loads a local file; failed loads roll back |
| Provider-aware request shaping | Keeps the prompt in the field each transport expects |
| Multi-model | Works with Responses, Chat Completions, Anthropic, Gemini, and OpenAI-compatible gateways |
| Zero disk state | Session state lives in memory; no state file is written |
| Status footer | Shows `PURGE ON` while active in interactive mode |

## Model support

The switch works at the request layer, not at a single model. It covers the transports omp uses for most mainstream providers and OpenAI-compatible gateways.

| Provider / model family | Transport | Status |
| --- | --- | --- |
| OpenAI GPT-5 / GPT-6 / o-series | `openai-responses` | Supported |
| xAI Grok (`xai`, `xai-oauth`) | `openai-responses` | Supported; model-side policy may still take priority |
| Anthropic Claude | `anthropic-messages` | Supported |
| Google Gemini / Vertex | `google-generative-ai` / `google-vertex` | Supported |
| DeepSeek, Qwen, Kimi, MiniMax, GLM | OpenAI-compatible gateway | Supported |
| OpenRouter, LiteLLM, custom gateways | OpenAI-compatible | Supported |
| Ollama, LM Studio, llama.cpp | Local OpenAI-compatible | Supported |

“Supported” means the plugin injects and composes the system prompt correctly for that transport. For `openai-responses`, it also moves the prompt from top-level `instructions` into a developer message so the model treats it as a session-level instruction.

Model-side policies are separate. Some providers attach their own system instructions on the server. The plugin controls the client request only. If a model ignores the injected prompt, try another model — the plugin does not switch models for you.

## Requirements

- omp `18.x` (tested on `18.12.5`)
- Any OS supported by omp: macOS, Linux, or Windows
- No build step; omp loads the TypeScript plugin directly
- The plugin must be enabled; if it is disabled, run `/plugins enable omp-purge` and restart the session

## Install

### Remote install

```bash
omp plugin install github:changjiangi/omp-purge
```

Pin a release:

```bash
omp plugin install github:changjiangi/omp-purge#v1.1.1
```

### Local source

```bash
omp plugin install ~/.omp/plugins-src/omp-purge
```

### Project scope

Clone the repository and link it into a project:

```bash
git clone https://github.com/changjiangi/omp-purge.git /tmp/omp-purge
OMP_PURGE_SRC=/tmp/omp-purge /tmp/omp-purge/scripts/install-project.sh /path/to/project
```

OMP ignores `--scope project` for `github:` sources, so project installation uses the script.

### After install

Restart the omp session. If the plugin is disabled:

```text
/plugins enable omp-purge
```

Then verify:

```text
/purge status
```

## Quick start

```text
/purge on
```

That is enough for the default setup: `strict` mode with the embedded persona.

Check the current state:

```text
/purge status
```

Turn it off for the session:

```text
/purge off
```

Use your own persona:

```text
/purge source /absolute/path/persona.md
/purge mode replace
/purge on
```

Switch back to the embedded persona:

```text
/purge source embedded
```

## Commands

| Command | Action |
| --- | --- |
| `/purge` | Toggle on/off for the current session |
| `/purge on` / `/purge off` | Explicit switch (`enable` / `disable` are aliases) |
| `/purge status` | Mode, persona source, character count, last prompt cut |
| `/purge mode strict` | Persona + working directory only |
| `/purge mode replace` | Persona + host prompt with identity and docs pointer removed |
| `/purge mode append` | Persona + original host prompt |
| `/purge source <path>` | Load a persona file |
| `/purge source embedded` | Restore the built-in persona |

Argument completion supports `on`, `off`, `status`, `mode`, and `source`.

## Modes

| Mode | System prompt sent | Best for |
| --- | --- | --- |
| `strict` (default) | Persona + `Current working directory: ...` only | Maximum isolation; single-variable experiments |
| `replace` | Persona + host prompt with its identity line and docs pointer removed | Keeping tools and project context while removing host identity |
| `append` | Persona + original host prompt unchanged | Control group; measuring the effect of adding a persona |

`replace` matches exact host text. If the host wording changes and a marker is not found, it leaves that section untouched instead of cutting at a guessed boundary. `/purge status` reports whether the identity and docs sections were matched.

`strict` does not depend on host wording, so it behaves the same across omp versions.

## How it works

1. `before_agent_start` builds the session system prompt from the selected mode.
2. `before_provider_request` adapts the outgoing payload for the transport:
   - `openai-responses`: top-level `instructions` is moved into an `input` developer message.
   - Other transports keep their native system field.
3. The model, provider, endpoint, credentials, and tools stay unchanged.
4. State is in memory only. `session_start` resets the switch to off.
5. When an external persona fails to load, the previous source is restored and `/purge status` keeps the error.

The request-shaping step is important: some Responses-compatible providers treat top-level `instructions` differently from an in-conversation developer message. omp-purge sends the shape that the model treats as a session-level instruction.

## Troubleshooting

### `/purge` is not registered

The plugin is disabled or the session was started before installation.

```text
/plugins enable omp-purge
```

Then restart the omp session.

### `/purge on` runs, but the reply still follows the host prompt

Run:

```text
/purge status
```

Check:

- mode: try `strict`
- source: confirm it is `embedded` or the intended file
- model: try a model that follows the injected prompt
- provider: some providers attach server-side instructions that the client cannot remove

The plugin changes the client prompt. It does not override a provider's server-side policy.

### `replace` reports “identity: unmatched” or “docs: unmatched”

The host prompt text changed. Use `strict` for a version-independent cut, or `append` to keep the host prompt intact.

### External persona fails to load

The error includes the exact path and reason:

```text
文件不存在: /path/persona.md
文件为空: /path/persona.md
```

The previous source is restored automatically. Fix the file, then run `/purge source` again.

### Footer does not show `PURGE ON`

Print and RPC modes have no footer. In interactive mode, the status key is `purge`.

## Sponsor

If `omp-purge` saves you time, you can support the project:

| Asset | Address |
| --- | --- |
| USDT (TRC20) | `TGY99GWPGiaZhg9pzfu9Visq5PpXkcdbjW` |
| BTC | `154gvGPUMJZHrGbTnaMmBMuFQppihoj4xF` |
| ETH (Ethereum) | `0xa8eef31f9c3691d6c058fd56e53754a0a61b18bb` |

## Development

```bash
git clone https://github.com/changjiangi/omp-purge.git
cd omp-purge
bun test/smoke.test.mjs
```

Project layout:

```text
omp-purge/
├── index.ts              # extension factory, persona, request shaping
├── assets/banner.svg     # README banner
├── test/smoke.test.mjs   # behavior assertions without model calls
├── scripts/              # project-scope installer
├── README.md             # English
└── README.zh-CN.md       # Chinese
```

The smoke test covers default-off behavior, all three modes, session reset, source rollback, request-shape rewriting, and the no-disk-state guarantee.

## License

MIT
