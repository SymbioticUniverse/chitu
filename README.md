# 赤兔 (Chitu)

人中吕布，马中赤兔。**架构不是设计出来的，是锁出来的。**

Chitu 是一个终端 AI Agent，核心创新是 **约束自涌现（Constraint Emergence）**——不以设计文档驱动架构，而是通过 Horsewhip 边界锁逐轮锁定已完成模块，让系统架构从约束中自然生长。

## 与现有 AI 编码工具的区别

| | Copilot / Cursor | OpenHands / SWE-Agent | **Chitu** |
|---|---|---|---|
| 模式 | 补全 / 问答 | 指令执行 | **约束涌现** |
| 架构来源 | 人工设计 | 人工指令 | **从接口锁中自发涌现** |
| 长时间任务 | 逐步退化 | 上下文膨胀后崩溃 | **上下文压缩，迭代不衰减** |
| 人工介入 | 持续 | 频繁 | **接近零** |

## 快速开始

```bash
# 从源码构建
git clone https://github.com/SymbioticUniverse/chitu.git
cd chitu && npm install && npm run build && npm link

# 配置 API Key
chitu config set apiKey <your-key>

# 在任意项目目录运行
cd your-project

# 启动 TUI 交互界面
chitu

# 或直接跑约束模式（自动迭代）
chitu run --task "搭建一个完整的 XXX 系统" --constraint
```

## TUI 交互界面

TUI 是 Chitu 的主力界面。终端输入 `chitu` 启动，看到赤兔马 banner 和底部 `>` 提示符。

### 四种范式（Shift+Tab 切换）

| 范式 | TUI 标签 | 说明 | Horsewhip | 自动 commit |
|------|----------|------|-----------|-------------|
| 相马（appraise） | `Ask` | 只读问答，不写代码 | 全锁 | — |
| 策马（ride） | `Target` | 完整工作流：Clarify→Plan→Execute→Review | 按 sub-goal 锁 | 否 |
| 刺马（spur） | `Modify` | 单文件精准编辑 | 精确锁指定文件 | 否 |
| 约束（constraint） | `Constraint` | 全自动迭代：Grow→Trim→Verify→auto commit | 硬锁 | **是** |

### 操作方式

```
> 搭建一个记账应用                         输入任务，按回车执行
Shift+Tab                                 切换范式
Ctrl+J                                    换行（多行输入）
/help                                     查看所有命令
/quit                                     退出
/clear                                    清屏
/compact                                  压缩上下文
```

### 全自动怎么跑？

约束（constraint）范式就是全自动 —— 在 TUI 里切到 `Constraint`，输入任务，它自己迭代、验证、commit，不需要你插手。

或者 CLI 一键启动：

```bash
chitu run --task "你的任务" --constraint
```

## 实战验证

在纯约束模式下，Chitu 用 **6 个独立会话、0 次人工干预**，构建了一个 **38 模块、19,419 行**的连锁商贸管理系统，**零循环依赖、四层架构分层正确、命名风格跨会话一致。**

Chitu 自身也由 Chitu 在约束模式下重构——**10 轮迭代、12 次 auto-commit、2 次自动回滚、HITL 0 次**，最大文件 1380→752 行。

## 架构概览

```
src/
├── agent.ts + agent/       # Agent 核心循环 + 上下文 + 工具执行
├── constraint/             # 约束引擎（lockIntent→Grow→Trim→Verify→Commit）
├── target/                 # 目标引擎（Clarify→Plan→Execute→Review）
├── horsewhip/              # 边界守卫（guard + audit + boundary-parser）
├── tui/                    # 终端 UI（12 模块，1082 行）
├── providers/              # AI 适配层（Claude / DeepSeek / OpenAI）
├── tools/                  # Agent 工具集
├── rollback/               # 安全回滚与锚点
├── routing.ts              # 语义路由
└── types.ts                # 核心类型定义
```

## 依赖

- Node.js >= 18
- AI API key（Claude / DeepSeek / OpenAI 任一）

## License

AGPL-3.0
