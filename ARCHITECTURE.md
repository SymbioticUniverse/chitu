# Chitu 架构文档

## 一、全景架构

```
                        ┌─────────────────────────┐
                        │         CLI 入口          │
                        │  chitu [--fengxian|       │
                        │  --yunchang|--constraint] │
                        │  chitu run/dev/resume/... │
                        └────────────┬────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────┐
│                          Agent (agent.ts)                           │
│                                                                     │
│  ┌──────────────┐  ┌──────────────────┐  ┌───────────────────────┐ │
│  │ 语义路由      │  │ 工具执行          │  │ 上下文管理            │ │
│  │ classifyIntent│  │ executeToolCalls │  │ maybeCompress         │ │
│  │ → 闲聊/任务/  │  │ → Horsewhip拦截  │  │ → 80%阈值触发归档     │ │
│  │   查询        │  │ → 审计记录       │  │ context.ts            │ │
│  │ routing.ts   │  │ tool-exec.ts     │  │                       │ │
│  └──────────────┘  └──────────────────┘  └───────────────────────┘ │
│                                                                     │
│  范式调度: execute() → appraise / ride / spur / constraint          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Target 引擎    │  │  Constraint 引擎 │  │   Horsewhip     │
│                 │  │                 │  │   边界守卫       │
│ Clarify→Plan→   │  │ lockIntent→     │  │                 │
│ Execute→Review  │  │ Grow→Trim→      │  │ decouple:全锁   │
│                 │  │ Verify→Commit   │  │ pasture:白名单  │
│ executor.ts     │  │                 │  │ guard.ts        │
│ execute-phase   │  │ executor.ts     │  │ audit.ts        │
│   .ts           │  │ gates.ts        │  │ boundary-parser │
│ state.ts        │  │ iteration.ts    │  │   .ts           │
│ plan.ts         │  │ interface.ts    │  │                 │
│ interface-doc   │  │ interface-graph │  │                 │
│   .ts           │  │ plan.ts         │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## 二、模块分层

### 入口层

| 文件 | 职责 |
|------|------|
| `index.ts` | 入口：检查工作目录 → HorsewhipSync → 分发 startTUI / main |
| `cli.ts` | 非交互 CLI：run / resume / metrics / list / dev / build / config |
| `global-config.ts` | `~/.chitu/config.json` 读写：apiKey / model / baseUrl |

### Agent 层

| 文件 | 行数 | 职责 |
|------|------|------|
| `agent.ts` | 752 | 核心 Agent：拥有 provider、guard、executor，运行会话循环 |
| `agent/context.ts` | 254 | 系统提示词构建 + 接口文档上下文注入 |
| `agent/tool-exec.ts` | 182 | 工具调用分发：Horsewhip 拦截 → 审计 → 执行 |
| `routing.ts` | 42 | classifyIntent：用 flash 模型分类用户意图 |
| `paradigm.ts` | 135 | 各范式（appraise/ride/spur/constraint）提示词片段 |
| `system-prompt.ts` | 142 | 核心系统提示词加载 + 项目配置注入 |

### 约束引擎（constraint/）

| 文件 | 行数 | 职责 |
|------|------|------|
| `executor.ts` | 288 | 约束模式主循环：lockIntent → Grow → Trim → Verify → Commit |
| `gates.ts` | 277 | 门禁验证：exports 一致性、expand 理由校验 |
| `iteration.ts` | 120 | commit、completion 计数 |
| `interface.ts` | 372 | FileInterface 类型：exports/imports/capability 的读写 |
| `interface-graph.ts` | 97 | 约束指令 + 上下文压缩 + 进度追踪 |
| `plan.ts` | 72 | MiniPlan 管理：`.chitu/plans/` 读写 |

### 目标引擎（target/）

| 文件 | 行数 | 职责 |
|------|------|------|
| `executor.ts` | 145 | Target 状态机骨架：Clarify → Plan → Execute → Review |
| `execute-phase.ts` | 1360 | 四阶段具体实现：doClarify / doPlan / doExecute / doReview |
| `state.ts` | 146 | TargetState JSON 持久化 |
| `plan.ts` | 419 | Plan 解析、goal 完整性检查、sub-goal 管理 |
| `interface-doc.ts` | 309 | 接口文档（contract.md）读写 |
| `verification.ts` | 65 | 验证文档生成 |

### 边界守卫（horsewhip/）

| 文件 | 行数 | 职责 |
|------|------|------|
| `guard.ts` | 416 | HorsewhipGuardImpl：边界检查、cmd 拦截、审计触发 |
| `audit.ts` | 73 | AuditLogger：结构化审计事件写入 session-audit.json |
| `boundary-parser.ts` | 65 | BoundaryFileManager：boundary.json 加载/缓存/变更 |

### 终端 UI（tui/）

| 文件 | 行数 | 职责 |
|------|------|------|
| `app.ts` | 1082 | startTUI：raw mode、主循环、状态栏调度、流式输出 |
| `state.ts` | 247 | TUIState 类型 + 常量定义 |
| `status-bar.ts` | 296 | 状态栏/模式栏/提示面板/指标渲染 |
| `render-stream.ts` | 191 | 流式渲染：token → 显示、assistant 块打印、banner |
| `input.ts` | 326 | 键盘输入处理：raw input、历史、paste、key bindings |
| `screen.ts` | 205 | 底层 ANSI 控制：raw mode、scroll region、颜色输出 |
| `visual.ts` | 97 | CJK 宽度计算、面板绘制工具 |
| `formatting.ts` | 49 | Markdown 终端渲染（粗体/斜体/代码/链接/标题） |
| `banner.ts` | 75 | 启动横幅渲染 |
| `horse.ts` | 92 | 赤兔马像素画 |

### AI Provider（providers/）

| 文件 | 职责 |
|------|------|
| `claude.ts` | Anthropic Claude API 适配 |
| `openai-compat.ts` | OpenAI 兼容基类（DeepSeek / OpenAI 共用） |
| `deepseek.ts` / `openai.ts` | 各 provider thin wrapper |
| `factory.ts` | Provider 工厂：auto-detect / 手动选择 |
| `sse.ts` | SSE 流读取器 |
| `types.ts` | Provider 接口类型 |
| `utils.ts` | 公共工具函数 |

### 回滚安全（rollback/）

| 文件 | 行数 | 职责 |
|------|------|------|
| `anchor.ts` | 127 | AnchorPoint 类型、锚点创建/回退执行 |
| `snapshot.ts` | 89 | 磁盘快照操作：创建/恢复 |
| `recovery.ts` | 306 | 启动自动恢复引擎 |
| `safe-mutation.ts` | 179 | safeMutation：操作前快照 → 执行 → 失败自动回滚 |

### 基础设施

| 文件 | 职责 |
|------|------|
| `types.ts` | 核心类型定义（Message / Paradigm / TargetState / SubGoal / Session 等） |
| `session.ts` | SessionManager：会话 CRUD |
| `soul.ts` | SoulManager：跨会话记忆 |
| `metrics.ts` | MetricsEngine：从审计事件计算六维指标 |
| `score.ts` | 项目信任评分 |
| `logger.ts` | 分级日志 |
| `sync.ts` | Horsewhip 版本同步 |
| `auditor.ts` | 审计事件写入抽象 |

### 工具（tools/）

| 文件 | 职责 |
|------|------|
| `index.ts` | 工具注册聚合 |
| `write.ts` | write_file / edit_file / delete_file / run_shell |
| `read.ts` | read_file / web_fetch 等只读操作 |
| `cli.ts` | cli_exec（只读 shell，拦截写命令） |
| `memory.ts` | 记忆系统工具 |
| `task.ts` | 任务管理工具 |
| `utils.ts` | 路径解析安全 |

## 三、三种运行模式

| 模式 | 标志 | 范式 | Horsewhip | 提交 | 用途 |
|------|------|------|-----------|------|------|
| TUI 交互 | `chitu` | 可选 | 有 guard | 手动 | 日常对话 |
| CLI headless | `chitu run --task "..."` | ride | 有 guard | 手动 | 单任务 |
| CLI auto | `chitu run --task "..." --yunchang` | ride | 有 guard | 自动 | 持续迭代 |
| CLI 约束 | `chitu run --task "..." --constraint` | constraint | 硬锁 | 自动 | 约束涌现 |
| Dev | `chitu dev --task "..."` | ride | 关闭 | 手动 | 调试开发 |

## 四、约束模式门禁流程

```
lockIntent(目标文件) → GROW(AI编码) → TRIM(指标检查) → VERIFY(3道门) → commit → 下一轮
                                                                           │
                                                              Gate 0: 空产出检测
                                                              Gate 1: exports 声明校验
                                                              Gate 3: 编译+测试
```

每轮 commit 后上下文压缩，只保留接口文档作为跨轮记忆。

## 五、数据持久化

| 路径 | 内容 |
|------|------|
| `.git/horsewhip/boundary.json` | 边界锁状态 |
| `.git/horsewhip/session-audit.json` | 审计事件（JSONL） |
| `.chitu/plans/plan-<id>.json` | 约束/目标计划 |
| `.chitu/interfaces/` | 接口文档目录 |
| `.chitu/sessions/<uuid>.json` | 会话记录 |
| `.chitu/soul.md` | 用户习惯记忆 |
| `.chitu/config.json` | 项目配置 |
| `~/.chitu/config.json` | 全局 API Key 配置 |
