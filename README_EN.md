<div align="center">

<img src="docs/logo.svg" alt="CHITU" width="600" />

*Architecture is not designed. It is locked in.*

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg?style=flat-square&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Provider](https://img.shields.io/badge/AI-DeepSeek%20%7C%20Claude%20%7C%20OpenAI-orange.svg?style=flat-square)]()

[中文](README.md)

</div>

---

> Chitu is a Git-native terminal AI agent powered by **Constraint Emergence** — a paradigm where architecture grows organically from locked interface boundaries rather than upfront design documents. Chitu is built on Git: boundary locking, auto-commit, and safe rollback all operate on Git primitives.

> **Chitu is built on [Horsewhip](https://github.com/SymbioticUniverse/horsewhip).** Horsewhip provides the boundary-locking engine, file guards, and auto-commit mechanics that make constraint emergence possible. For the full experience — including VS Code / Cursor extension, real-time boundary visualization, and guard intercepts — check out the [Horsewhip project](https://github.com/SymbioticUniverse/horsewhip).

## Quick Start

```bash
git clone https://github.com/SymbioticUniverse/chitu.git
cd chitu && npm install && npm link
chitu
```

First launch walks you through a **setup wizard** — pick your AI provider, paste your API key, done. After that, `chitu` drops you straight into the TUI.

### Startup Behavior

| Scenario | Behavior |
|:---|:---|
| Git-initialized project directory | Launches TUI directly |
| Project directory without Git (`package.json`, `src/`, etc.) | Prompts `Run git init to initialize? [Y/n]`, auto-inits on Enter |
| Non-project directory (Desktop, Downloads, etc.) | Forces Ask (read-only) mode, directs user to a project directory |

---

## TUI Interaction

Launch with `chitu` in any project directory. The TUI runs entirely in your terminal — tab to switch modes, type to chat, watch constraint iterations unfold in real time.

### Controls

| Key | Action |
|:---|:---|
| `Tab` | Switch paradigm (Ask ⇄ Constraint) |
| `Ctrl` + `J` | Newline (multi-line input) |
| `/help` | Show all commands |
| `/quit` | Quit |
| `/clear` | Clear screen |
| `/compact` | Compress context |

### Paradigms

| Paradigm | Label | What it does | Files | Commit |
|:---|:---|:---|---:|:---:|
| **Ask** `appraise` | <kbd>Ask</kbd> | Read-only Q&A — explore, understand, audit | Locked | — |
| **Constraint** `constraint` | <kbd>Constraint</kbd> | Autonomous iteration — declare intent, watch it build | New only | Auto |

> **Ask** is your codebase companion. Ask about architecture, trace dependencies, understand patterns. Horsewhip fully locks all files — zero risk of accidental changes.

> **Constraint** is autonomous evolution. Declare a sub-goal. Chitu locks a boundary, writes code within it, verifies everything compiles, and auto-commits only what passes. Rinse and repeat until the entire task is done. No human in the loop.

---

## Constraint Emergence

The core insight: if you lock what works and force all new code through a verify-then-commit gate, the architecture converges toward correctness on its own. No design doc needed.

### The Loop

<div align="center">

```
 ┌──────────┐     ┌────────┐     ┌────────┐     ┌──────────┐     ┌──────────┐
 │ lockIntent│ ──→ │  Grow  │ ──→ │  Trim  │ ──→ │  Verify  │ ──→ │  Commit  │
 └──────────┘     └────────┘     └────────┘     └──────────┘     └──────────┘
       ↑                                                                 │
       └─────────────────── next sub-goal ──────────────────────────────┘
```

</div>

| Phase | What happens |
|:---|:---|
| **lockIntent** | Declare a sub-goal + the files it touches. Horsewhip locks existing files — only new files are writable. |
| **Grow** | The AI writes code inside the boundary, importing from locked modules via their documented interfaces. |
| **Trim** | Strip dead code, deduplicate, ensure exports are clean and intentional. |
| **Verify** | Mechanical gates: no empty output → exports are declared → compilation passes → tests pass. |
| **Commit** | Pass = auto-commit. Fail = auto-rollback + retry with failure feedback. |

The boundary creeps forward each iteration — yesterday's new file is today's locked interface. Architecture emerges from the accumulated lock surface.

### Context Orchestration

Autonomous iteration has a context problem: too much history and the AI collapses under bloat; too little and it repeats mistakes. Chitu solves this with a **two-tier model**.

| Tier | Contents | Lifetime |
|:---|:---|:---|
| **Interface Graph** | Module paths, exports, type signatures, dependency edges | Permanent — committed to disk |
| **Conversation** | Current sub-goal reasoning, tool calls, verification results | One iteration — then compressed |

<div align="center">

```
  Iteration N                              Iteration N+1
 ┌──────────────────────┐                 ┌──────────────────────┐
 │                      │                 │                      │
 │  Full conversation   │    compress     │  Interface graph     │
 │  · Tool calls        │  ───────────→   │  of locked modules   │
 │  · AI reasoning      │                 │                      │
 │  · Verification logs │                 │  + New sub-goal      │
 │                      │                 │                      │
 └──────────────────────┘                 └──────────────────────┘
```

</div>

When an iteration completes, the conversation is discarded — but the **interface graph** of newly-locked modules persists. The next iteration starts fresh, reading only the interface graph (not the full source) to understand the codebase. A 10,000-line codebase compresses to roughly 500 lines of interface docs. The AI reads full source only when it needs to modify or deeply understand a specific module.

This is why Chitu doesn't degrade over long tasks: context stays lean, but architectural awareness stays complete.

---

## How Chitu Differs

| | Copilot / Cursor | OpenHands / SWE-Agent | **Chitu** |
|:---|:---|:---|:---|
| **Paradigm** | Completion / Q&A | Instruction execution | **Constraint emergence** |
| **Architecture** | Human-designed | Human-instructed | **Emerged from locked interfaces** |
| **Long tasks** | Degrades over time | Context bloat → collapse | **Compressed context, no decay** |
| **Human involvement** | Continuous | Frequent | **Near zero** |

---

## Real-world Results

| Project | Scale | Sessions | Human intervention | Outcome |
|:---|:---|:---|:---|:---|
| Supply chain system | 38 modules, 19,419 lines | 6 independent sessions | **Zero** | Clean four-layer architecture, zero circular imports |
| Chitu self-refactoring | 1,380 → 752 lines | 1 session, 10 iterations | **Zero** | 12 auto-commits, 2 auto-rollbacks, clean split |

---

## Architecture

```
src/
├── agent.ts + agent/       # Core loop · context compression · tool dispatch
├── constraint/             # Constraint engine — lockIntent→Grow→Trim→Verify→Commit
├── target/                 # Target engine — Clarify→Plan→Execute→Review
├── horsewhip/              # Boundary guard — lock · audit · boundary-parser
├── tui/                    # Terminal UI — 12 modules, full keyboard control
├── providers/              # AI adapters — DeepSeek · Claude · OpenAI · Custom
├── tools/                  # Agent tools + auto-install (MCP / Skills / CHITU.md)
├── rollback/               # Safe rollback + anchor points
├── routing.ts              # Semantic intent routing
└── types.ts                # Core types
```

---

## CLI Commands

For headless, CI, or scripting use:

```bash
chitu run --task "Build an inventory management system" --constraint
chitu run --task "Fix the login timeout bug" --auto
chitu resume <session-id>
chitu dev --task "Add unit tests for auth module"
chitu config set apiKey <key>
chitu config set provider claude
chitu metrics [session-id]
chitu list
chitu sync
chitu build
chitu help
```

| Option | Description |
|:---|:---|
| `--task, -t <task>` | Task description |
| `--session, -s <id>` | Session ID (for resume) |
| `--model, -m <model>` | Model name (default: `deepseek-v4-pro`) |
| `--api-key <key>` | API key override |
| `--base-url <url>` | API base URL override |
| `--thinking` | Enable deep reasoning mode |
| `--auto` | Auto-commit mode (with `run`) |
| `--constraint` | Constraint mode (with `run`) |

---

## Requirements

- **Node.js** >= 18
- **API key** — [DeepSeek](https://platform.deepseek.com) · [Claude](https://console.anthropic.com) · [OpenAI](https://platform.openai.com)

---

## License

[AGPL-3.0](LICENSE) · Made with [Horsewhip](https://github.com/SymbioticUniverse/horsewhip)
