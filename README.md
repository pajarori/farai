<div align="center">

# Farai

Cyber-first local AI agent for terminal-driven security work.

<p>
  <a href="https://www.npmjs.com/package/farai"><img src="https://img.shields.io/npm/v/farai?style=flat&logo=npm&color=CB3837" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
  <a href="https://github.com/pajarori/farai/stargazers"><img src="https://img.shields.io/github/stars/pajarori/farai?style=flat&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/pajarori/farai/network/members"><img src="https://img.shields.io/github/forks/pajarori/farai?style=flat&logo=github" alt="GitHub forks"></a>
</p>

</div>

<p align="center">
  <img src="https://raw.githubusercontent.com/pajarori/farai/main/docs/assets/farai.gif" alt="Farai terminal demo" width="900">
</p>

Farai is a local AI agent built for CTFs, lab automation, security research, and long-running technical workflows. It runs from the terminal, keeps sessions resumable, executes tools locally or inside a Kali Docker runtime, and preserves tool output, artifacts, usage, and evidence so work can be reviewed instead of only trusted from a final answer.

For CSI/CyBench materials and exploratory benchmark artifacts, see [farai-csi-bench](https://github.com/pajarori/farai-csi-bench).

## Installation

```bash
npm install -g farai
farai setup
farai
```

Or with Bun:

```bash
bun install -g farai
farai setup
farai
```

Requirements:

- Bun 1.1+
- Node.js 20+
- Docker
- A model provider/API key, unless using an already configured default provider

## Setup

Configure Farai and prepare the local runtime:

```bash
farai setup
```

Configure a model provider during setup:

```bash
farai setup \
  --model openai:gpt-5 \
  --base-url https://api.openai.com/v1 \
  --api-key-env OPENAI_API_KEY
```

Skip heavier setup steps when needed:

```bash
farai setup --no-docker
farai setup --no-kb
```

Check the environment:

```bash
farai doctor
```

## Usage

Open the interactive TUI:

```bash
farai
```

Run a one-shot prompt:

```bash
farai run "scan the target and summarize exposed services"
```

Create a named session:

```bash
farai init --name htb-box --target 10.10.10.10
```

Resume a session:

```bash
farai resume htb-box
```

Change or add a model provider:

```bash
farai model
farai model add openai/gpt-5 --base-url https://api.openai.com/v1 --api-key-env OPENAI_API_KEY --set-default
```

Run benchmark manifests:

```bash
farai bench run manifest.json --artifacts /tmp/farai-results
farai bench suite suite.json --artifacts /tmp/farai-results
```

## Commands

| Command | Description |
|---|---|
| `farai` | Open the interactive terminal UI |
| `farai setup` | Prepare config, Docker runtime, local data, and optional model provider |
| `farai run` | Execute a one-shot prompt |
| `farai resume` | Continue a saved session |
| `farai init` | Create a named session |
| `farai model` | List or add model providers |
| `farai bench` | Run benchmark manifests and suites |
| `farai doctor` | Verify the local environment |
| `farai config` | Print config and auth paths |

Config and auth files live under:

```text
~/.local/pajarori/farai/
```

## Status

Farai is under active development.

The current defensible claim is that Farai has substantial implementation validation and an evidence-oriented agent architecture. Stronger claims require clean benchmark campaigns, stronger isolation, canonical scoring, and larger empirical evaluations.

Early benchmark artifacts should be treated as exploratory unless the run artifact, oracle, isolation policy, model selection, and challenge materials are frozen and auditable.

## License

Apache License 2.0
