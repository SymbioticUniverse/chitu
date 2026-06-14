<div align="center">

<img src="docs/logo.svg" alt="CHITU" width="600" />

**架构不是设计出来的，是锁出来的。**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg?style=flat-square&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Provider](https://img.shields.io/badge/AI-DeepSeek%20%7C%20Claude%20%7C%20OpenAI-orange.svg?style=flat-square)]()

[English](README_EN.md)

</div>

---

> 赤兔（Chitu）是一个基于 Git 仓库的终端 AI 智能体，其核心创新是**约束涌现**（Constraint Emergence）——通过 Horsewhip 边界锁定，逐轮固化已完成模块，迫使系统架构从约束中自然生长，而非依赖设计文档。Chitu 高度依赖 Git：边界锁定、自动提交、安全回滚等全部核心机制均构建于 Git 原语之上。

> **本项目基于 [Horsewhip](https://github.com/SymbioticUniverse/horsewhip) 构建。** Horsewhip 是约束涌现的底层引擎，提供边界锁定、文件守卫与自动提交能力。如需完整体验——包括 VS Code / Cursor 插件、实时边界可视化与守卫拦截——请前往 [Horsewhip 项目主页](https://github.com/SymbioticUniverse/horsewhip) 了解详情。

## 快速开始

```bash
git clone https://github.com/SymbioticUniverse/chitu.git
cd chitu && npm install && npm link
chitu
```

首次启动会进入**配置向导**——选择 AI 服务商、输入 API Key 即可。之后直接 `chitu` 进入 TUI。

### 启动行为

| 场景 | 行为 |
|:---|:---|
| 已初始化 Git 的项目目录 | 直接进入 TUI |
| 未初始化的项目目录（有 `package.json`、`src/` 等） | 提示 `Run git init to initialize? [Y/n]`，回车自动 `git init` |
| 非项目目录（桌面、下载等） | 强制进入 Ask 只读模式，提示前往项目目录 |

---

## TUI 交互

在任意项目目录执行 `chitu` 进入终端交互界面。Tab 切换模式，输入即对话，约束迭代过程实时可见。

### 状态栏

底部状态栏实时显示：当前迭代用时、Token 消耗（含缓存命中率）、上下文使用率、Horsewhip 守卫活动指标。

| 指标 | 示例 | 说明 |
|:---|:---|:---|
| Token | `12.5K tokens  cache:85%` | 本次会话消耗的 Token 及缓存命中率 |
| 上下文 | `ctx:42%` | 上下文窗口使用百分比 |
| 守卫 | `守:24✓ 3✗` | Horsewhip 放行/拦截写入次数 |

### 操作

| 按键 | 功能 |
|:---|:---|
| `Tab` | 切换范式（Ask ⇄ Constraint ⇄ Manual） |
| `Ctrl` + `J` | 换行（多行输入） |
| `/help` | 显示所有命令 |
| `/quit` | 退出 |
| `/clear` | 清屏 |
| `/compact` | 压缩上下文 |
| `/update` | 一键更新到最新版本 |
| 输入文字 | LLM 运行时也可打字，发送后排队，任务完成后自动消费 |

### 范式

| 范式 | 标签 | 功能 | 文件 | 自动提交 |
|:---|:---|:---|---:|:---:|
| **Ask** `appraise` | <kbd>Ask</kbd> | 只读问答——探索、理解、审计代码 | 全部锁定 | — |
| **Constraint** `constraint` | <kbd>Constraint</kbd> | 自主迭代——声明意图，自动构建 | 仅新建 | 是 |
| **Manual** `manual` | <kbd>Manual</kbd> | 手动模式——自由读写，无内部锁，仅受 Horsewhip 插件约束 | 无限制 | — |

> **Ask** 是你的代码助手。可以询问架构、追踪依赖、理解模式。Horsewhip 完全锁定所有文件，零误改风险。

> **Constraint** 是自主演化模式。声明子目标，Chitu 锁定边界、在边界内编写代码、验证编译通过，并自动提交通过验证的成果。循环往复直到任务完成，无需人工干预。

> **Manual** 是纯手动模式，专为配合 Horsewhip 插件使用。此模式下 Chitu 不做任何内部边界锁定或自动提交，完全跟随用户指令自由读写文件。所有安全策略由 Horsewhip 插件在外部执行。**MCP、Skills 等第三方扩展的安装与配置请在 Manual 模式下进行。**

---

## 约束涌现

核心洞见：如果你锁定已完成的部分，并强制所有新代码通过验证-提交关卡，架构会自行收敛到正确状态，无需设计文档。

### 迭代循环

<div align="center">

```
 ┌──────────┐     ┌────────┐     ┌────────┐     ┌──────────┐     ┌──────────┐
 │ lockIntent│ ──→ │  Grow  │ ──→ │  Trim  │ ──→ │  Verify  │ ──→ │  Commit  │
 └──────────┘     └────────┘     └────────┘     └──────────┘     └──────────┘
       ↑                                                                 │
       └─────────────────── 下一个子目标 ──────────────────────────────┘
```

</div>

| 阶段 | 说明 |
|:---|:---|
| **lockIntent** | 声明子目标及涉及的文件范围。Horsewhip 锁定已有文件，仅新建文件可写。 |
| **Grow** | AI 在锁定边界内编写代码，通过已锁定模块的文档化接口进行导入。 |
| **Trim** | 去除死代码、合并冗余逻辑、确保导出干净且意图明确。 |
| **Verify** | 机械关卡：输出非空 → 导出已声明 → 编译通过 → 测试通过。 |
| **Commit** | 通过则自动提交，失败则自动回滚并用失败反馈重试。连续 3 次未通过则压缩上下文并重新开始当前迭代（最多 3 轮压缩 = 9 次尝试）。 |

边界每一轮都在前移——昨天的"新建文件"就是今天的"锁定接口"。架构从不断积累的锁定表面中涌现。

### 上下文编排

自主迭代面临上下文难题：记住太多则膨胀崩溃，记住太少则重复犯错。Chitu 用**双层模型**解决这个问题。

| 层级 | 内容 | 生命周期 |
|:---|:---|:---|
| **接口图** | 模块路径、导出、类型签名、依赖关系 | 永久——提交到磁盘 |
| **对话** | 当前子目标的推理、工具调用、验证结果 | 单次迭代——然后压缩 |

<div align="center">

```
  第 N 轮迭代                              第 N+1 轮迭代
 ┌──────────────────────┐                 ┌──────────────────────┐
 │                      │                 │                      │
 │  完整对话             │     压缩       │  锁定模块的          │
 │  · 工具调用           │  ───────────→  │  接口图              │
 │  · AI 推理            │                 │                      │
 │  · 验证日志           │                 │  + 新子目标          │
 │                      │                 │                      │
 └──────────────────────┘                 └──────────────────────┘
```

</div>

每次迭代完成后，对话被丢弃——但新锁定模块的**接口图**会持久化。下一轮迭代从接口图（而非完整源码）开始理解代码库。一万行代码压缩为约五百行接口文档。AI 仅在需要修改或深入理解特定模块时才读取完整源文件。

启动时 `scanAndIndexAllFiles` 预扫描全部源文件构建完整接口图——支持 Python（`def`/`class`/`__all__`/`from-import`）、TypeScript、JavaScript、Vue 等。AI 从接口图获取全局架构感知，无需反复浏览文件。

这就是 Chitu 在长任务中不会退化的原因：上下文始终精简，但架构感知始终完整。

---

## 与其他工具的区别

| | Copilot / Cursor | OpenHands / SWE-Agent | **Chitu** |
|:---|:---|:---|:---|
| **范式** | 补全 / 问答 | 指令执行 | **约束涌现** |
| **架构** | 人类设计 | 人类指令 | **从锁定接口中涌现** |
| **长任务** | 随时间退化 | 上下文膨胀 → 崩溃 | **压缩上下文，不衰减** |
| **人工介入** | 持续 | 频繁 | **趋近于零** |

---

## 实战成果

| 项目 | 规模 | 会话数 | 人工干预 | 结果 |
|:---|:---|:---|:---|:---|
| 供应链系统 | 38 模块, 19,419 行 | 6 个独立会话 | **零** | 四层架构清晰，零循环依赖 |
| Chitu 自重构 | 1,380 → 752 行 | 1 会话, 10 轮迭代 | **零** | 12 次自动提交, 2 次自动回滚 |
| PMagent 重构 | Python FastAPI, 21 文件 | 1 会话, 20+ 轮迭代 | **零** | 模块化拆分，接口完整索引 |

---

## 架构

```
src/
├── agent.ts + agent/       # 核心循环 · 上下文压缩 · 工具调度
├── constraint/             # 约束引擎 — lockIntent→Grow→Trim→Verify→Commit
├── target/                 # Target 引擎 — Clarify→Plan→Execute→Review
├── horsewhip/              # 边界守卫 — 锁定 · 审计 · 边界解析
├── tui/                    # 终端 UI — 12 个模块，全键盘操控
├── providers/              # AI 适配器 — DeepSeek · Claude · OpenAI · Custom
├── tools/                  # Agent 工具 + 自动安装（MCP / Skills / CHITU.md）
├── rollback/               # 安全回滚 + 锚点
├── routing.ts              # 语义意图路由
└── types.ts                # 核心类型定义
```

---

## 提示词体系

Chitu 的 system prompt 由多个模块分层组装，用户可在 `~/.chitu/` 和项目 `.chitu/` 下自定义规则。

### System Prompt 组装顺序

```
agent.ts → rebuildSystemPrompt()
  ┌─────────────────────────────────────────────┐
  │ ① loadSystemPrompt()      ← 主系统提示词    │
  │ ② PROGRESS_NOTE            ← 进度提示       │
  │ ③ getScoreContext()        ← 评分上下文     │
  │ ④ getParadigmPrompt()      ← 范式指令       │
  │ ⑤ SoulManager.toPrompt()   ← 用户习惯记忆   │
  └─────────────────────────────────────────────┘
```

### loadSystemPrompt() 内部 6 层

| 层 | 来源 | 内容 | 可自定义 |
|:---|:---|:---|:---:|
| 1 | `prompts/base.md` | 身份定义、行为规范、输出格式 | |
| 2 | `prompts/engineering.md` | 架构、工作流、指标 | |
| 3 | `prompts/company.md` | 公司/产品信息 | |
| 4 | `<项目>/.chitu/CHITU.md` | 用户项目级规则 | ✓ |
| 5 | `~/.chitu/CHITU.md` | 用户全局规则（跨项目） | ✓ |
| 6 | `<项目>/.chitu/config.json` | 技术栈、架构、关键文件 | ✓ |

### 用户自定义

创建对应文件即可生效，无需重启：

```bash
# 项目级规则 — 仅当前项目生效
echo "本项目使用 Functional Programming 风格" > .chitu/CHITU.md

# 全局规则 — 所有项目生效
echo "请始终用中文回复" > ~/.chitu/CHITU.md
```

### 用户习惯记忆

Chitu 自动从对话中总结用户偏好，存入 `.chitu/soul.md`，每次迭代后更新。内容示例：

> 用户偏好：先制定详细计划，模块化分步编码，读写计划与接口文件，交叉验证后迭代。

---

## 扩展体系

### MCP 加载优先级

Chitu 启动时按以下顺序加载 MCP 服务器：

| 优先级 | 配置文件 | 说明 |
|:---|:---|:---|
| 1 | `<项目>/.chitu/config.json` → `mcpServers` | 项目级配置 |
| 2 | `<项目>/.mcp.json` | 兼容 Claude Code |
| 3 | `~/.chitu/mcp.json` | 全局 MCP 配置 |

Horsewhip MCP 由 `chitu sync` 同步后自动写入 `.chitu/config.json`。

### Skills 加载

Skills 从 `<项目>/.chitu/skills/` 目录自动加载，每个子目录为一个 skill，包含 `skill.json` 或 `skill.yaml`：

```
.chitu/skills/
├── horsewhip/skill.json       ← chitu sync 自动同步
├── horsewhip-lock/skill.json
├── horsewhip-auto/skill.json
└── my-custom-skill/skill.json ← 用户自行安装
```

### 一键安装 MCP / Skills

在 **Manual 模式**下，通过 Agent 工具执行：

```
mcp_auto_install  → git clone → npm install → 安全扫描 → 注册到 .chitu/config.json
skill_auto_install → git clone → npm install → 安全扫描 → 写入 .chitu/skills/
```

安装后重启或 `/mcp-reload` 热加载即可使用。

---

## CLI 命令

用于无头模式、CI 或脚本调用：

```bash
chitu run --task "构建一个库存管理系统" --constraint
chitu run --task "修复登录超时 bug" --auto
chitu resume <session-id>
chitu dev --task "为 auth 模块添加单元测试"
chitu config set apiKey <key>
chitu config set provider claude
chitu list
chitu sync
chitu update
chitu uninstall
chitu build
chitu help
```

| 选项 | 说明 |
|:---|:---|
| `--task, -t <task>` | 任务描述 |
| `--session, -s <id>` | 会话 ID（用于恢复） |
| `--model, -m <model>` | 模型名称（默认：`deepseek-v4-pro`） |
| `--api-key <key>` | API 密钥覆盖 |
| `--base-url <url>` | API 基础 URL 覆盖 |
| `--thinking` | 启用深度推理模式 |
| `--auto` | 自动提交模式（配合 `run` 使用） |
| `--constraint` | 约束模式（配合 `run` 使用） |

---

## 环境要求

- **Node.js** >= 18
- **API Key** — [DeepSeek](https://platform.deepseek.com) · [Claude](https://console.anthropic.com) · [OpenAI](https://platform.openai.com)

---

## 许可证

[AGPL-3.0](LICENSE) · 基于 [Horsewhip](https://github.com/SymbioticUniverse/horsewhip) 构建
