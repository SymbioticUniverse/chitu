# Chitu (赤兔)

<div align="center">

**Architecture is not designed. It is locked in.**

[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Provider](https://img.shields.io/badge/AI-Claude%20%7C%20DeepSeek%20%7C%20OpenAI-orange.svg)]()

</div>

---

Chitu is a terminal AI agent whose core innovation is **Constraint Emergence** — instead of driving architecture through design documents, Horsewhip boundary locks lock completed modules round by round, forcing the system architecture to grow naturally from constraints.

## Table of Contents

- [How Chitu Differs](#how-chitu-differs)
- [Quick Start](#quick-start)
- [Paradigms](#paradigms)
  - [Target vs Constraint](#target-vs-constraint)
- [Real-world Results](#real-world-results)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [License](#license)

## How Chitu Differs

| | Copilot / Cursor | OpenHands / SWE-Agent | **Chitu** |
|---|---|---|---|
| Mode | Completion / Q&A | Instruction execution | **Constraint emergence** |
| Architecture | Human-designed | Human-instructed | **Emerges from locked interfaces** |
| Long-running tasks | Degrades over time | Context bloat → collapse | **Context compression, no decay** |
| Human intervention | Continuous | Frequent | **Near zero** |

## Quick Start

**Prerequisites:** Node.js >= 18, an API key from Claude / DeepSeek / OpenAI.

```bash
# Install from source
git clone https://github.com/SymbioticUniverse/chitu.git
cd chitu && npm install && npm run build && npm link

# Configure your API key
chitu config set apiKey <your-key>

# Launch the TUI in any project directory
cd your-project && chitu

# Or run constraint mode directly
chitu run --task "Build a complete inventory management system" --constraint
```

## Paradigms

Chitu has four paradigms. Press `Shift+Tab` in the TUI to cycle through them.

| Paradigm | Label | Description | Horsewhip | Auto commit |
|---|---|---|---|---|
| Ask (`appraise`) | `Ask` | Read-only Q&A, no code changes | Full lock | — |
| Target (`ride`) | `Target` | Goal-driven: Clarify → Plan → Execute → Review | Per sub-goal lock | No |
| Modify (`spur`) | `Modify` | Single-file surgical edit | Precise file lock | No |
| Constraint (`constraint`) | `Constraint` | Autonomous iteration: Grow → Trim → Verify → Commit | Hard lock | **Yes** |

### TUI Controls

```
Shift+Tab      Cycle paradigm
Ctrl+J         Newline (multi-line input)
/help          Show all commands
/quit          Quit
/clear         Clear screen
/compact       Compress context
```

### Target vs Constraint

Both modes build software autonomously. The difference is **how** they ensure correctness.

| | Target | Constraint |
|---|---|---|
| **Driven by** | A human-authored plan | Locked interface boundaries |
| **Workflow** | Clarify → Plan → Execute → Review (4 phases) | lockIntent → Grow → Trim → Verify → Commit (loop) |
| **Verification** | Semantic: tests pass, exports exist, cross-module integration, commit traceability | Mechanical: empty output, exports declaration, compile + test |
| **File policy** | All files editable | Committed files locked, only new files writable |
| **Best for** | Well-scoped tasks with clear requirements | Exploratory builds where design should emerge |
| **HITL** | Review phase flags issues for human judgment | Zero — auto-commits or auto-rolls back |
| **Context** | Full conversation per phase | Compressed per iteration; only interface docs persist |

**Target** is plan-driven — you define the goal, and the AI verifies it built the right thing.
**Constraint** is boundary-driven — you lock what works, and the system grows organically from those boundaries.

## Real-world Results

**38-module supply chain system** — built across 6 independent sessions with **zero human intervention**: 19,419 lines, zero circular dependencies, correct four-layer architecture, consistent naming across sessions.

**Chitu self-refactoring** — Chitu refactored itself in constraint mode: 10 iterations, 12 auto-commits, 2 automatic rollbacks, **0 HITL events**. Largest file: 1380 → 752 lines.

## Architecture

```
src/
├── agent.ts + agent/       # Core agent loop, context, tool execution
├── constraint/             # Constraint engine (lockIntent → Grow → Trim → Verify → Commit)
├── target/                 # Target engine (Clarify → Plan → Execute → Review)
├── horsewhip/              # Boundary guard (guard + audit + boundary-parser)
├── tui/                    # Terminal UI (12 modules, 1082 lines)
├── providers/              # AI provider adapters (Claude / DeepSeek / OpenAI)
├── tools/                  # Agent tool set
├── rollback/               # Safe rollback & anchor points
├── routing.ts              # Semantic intent routing
└── types.ts                # Core type definitions
```

## Requirements

- **Node.js** >= 18
- **AI API key** — Claude, DeepSeek, or OpenAI

## License

[AGPL-3.0](LICENSE)
