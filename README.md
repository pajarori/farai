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
```

Requirements:

- Bun 1.1+
- Docker
- A model provider/API key, unless using an already configured default provider

## Setup

Configure Farai and prepare the local runtime:

```bash
farai setup
```

## Usage

Open the interactive:

```bash
farai
```

Config and auth files live under:

```text
~/.local/pajarori/farai/
```

Farai checks the separate [farai-data](https://github.com/pajarori/farai-data) release channel before opening the TUI. When a validated release manifest publishes new knowledge or skills, Farai asks before downloading it. The current content can be inspected or managed without starting a session:

```bash
farai update status
farai update check
farai update apply
farai update rollback
```

Set `FARAI_CONTENT_MANIFEST_URL` for a private channel or local `file://` manifest, and `FARAI_CONTENT_DIR` to isolate the local content store. Set `FARAI_DISABLE_CONTENT_UPDATE=1` to disable the channel.

## Status

Farai is under active development.

The current defensible claim is that Farai has substantial implementation validation and an evidence-oriented agent architecture. Stronger claims require clean benchmark campaigns, stronger isolation, canonical scoring, and larger empirical evaluations.

Early benchmark artifacts should be treated as exploratory unless the run artifact, oracle, isolation policy, model selection, and challenge materials are frozen and auditable.

## License

Apache License 2.0
