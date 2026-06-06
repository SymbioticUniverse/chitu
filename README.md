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

## 核心理念

> 修改已有代码 → `/horsewhip`（intent-lock，牧场模式）
> 新增文件/功能 → `/horsewhip-lock-auto`（解耦全锁，自动 commit）
> 审核代码 → `/horsewhip-lock`（全锁只读）

每一个模块建成后，Horsewhip 锁住它的接口不允许修改。后续模块只能**读取接口、适配约束**——分层的架构不是某个人画出来的，是 AI 在被锁定的接口之间被逼出来的。

## 快速开始

### 安装

```bash
# 从源码构建
git clone https://github.com/SymbioticUniverse/chitu.git
cd chitu && npm install && npm run build && npm link
```

### 5 分钟体验

```bash
# 进入任意项目目录
cd your-project

# 新增功能：自动锁定旧文件，AI 自由创建新文件
chitu run --task "搭建一个完整的 XXX 系统模块" --constraint

# 修改已有代码：声明修改范围，锁定其他文件
chitu run --task "修复 XXX bug，涉及 A 和 B 两个文件"
```

Chitu 会：
1. 自动分析现有代码和接口文档
2. 通过 Horsewhip 声明修改边界
3. 写完代码后自动验证、提交、生成接口文档
4. 压缩上下文，准备下一轮迭代

### 工作流模式

| 命令 | 场景 | 说明 |
|---|---|---|
| `/horsewhip-lock-auto` | 新模块 | 旧文件只读锁死，新文件自动 commit |
| `/horsewhip` | 修改旧文件 | 先用 `lock_intent` 声明范围再改 |
| `/horsewhip-lock` | 审查审核 | 全文件只读，只分析不写 |

## 实战验证：连锁商贸全业态管理系统

在纯约束模式下，Chitu 用 **6 个独立会话、0 次人工干预**，构建了一个 **38 模块、19,419 行**的连锁商贸管理系统：

- 三端合一 SPA（C端会员 + 门店操作员 + 总部管理端）
- 完整业务链路：采购 → 入库 → 调拨 → 销售 → 退货 → 佣金扣减 → 月结
- 全链路集成测试，8 阶段 59 项断言

关键结果：**零循环依赖、四层架构分层正确、命名风格跨 6 个会话保持一致。** 没有人设计过这个架构——它是锁出来的。

完整演示项目请参见示例仓库。

## 架构概览

```
src/
├── agent.ts              # Agent 核心循环
├── constraint/           # 约束模式引擎
│   ├── executor.ts       # 迭代执行、评分、上下文压缩
│   ├── interface.ts      # 接口文档读写
│   └── plan.ts           # 计划文件管理
├── horsewhip/            # 边界锁守卫
│   └── guard.ts          # 文件读写拦截、命令审查
├── providers/            # AI 模型适配层（Claude / DeepSeek / OpenAI）
├── tools/                # Agent 工具（read / write / edit / shell / task）
├── rollback/             # 安全回滚与锚点
└── tui/                  # 终端 UI
```

## 配置

在项目根目录放置 `.chitu/settings.json`：

```json
{
  "model": "claude-opus-4-7",
  "autoCommit": true,
  "horsewhip": {
    "mode": "decouple"
  }
}
```

## 要求

- Node.js >= 18
- AI API key（Claude / DeepSeek / OpenAI 任一）

## License

AGPL-3.0
