# 赤兔 (Chitu) 架构文档

## 一、全景架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                          用户入口 (CLI)                              │
│              chitu / chitu --fengxian → 奉先模式 (手动, 有 guard)    │
│              chitu --dev             → TUI 开发模式 (无 guard)      │
│              chitu --yunchang        → 云长模式 (auto commit)      │
│              chitu dev/build/sync    → CLI 子命令 (非 TUI)          │
│              chitu run/resume/metrics/list → CLI 子命令             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      TUI (src/tui/app.ts)                           │
│  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌──────────────────┐ │
│  │ 输入处理  │  │ 流式渲染   │  │ 状态栏     │  │ 命令提示面板      │ │
│  │ raw mode │  │ token→显示 │  │ 六维+token │  │ /help /resume ..│ │
│  │ 历史记录  │  │ 工具输出   │  │ HITL+ctx   │  │ Shift+Tab切范式  │ │
│  └──────────┘  └───────────┘  └────────────┘  └──────────────────┘ │
│                              │                                      │
│              handleTask() ──▶ runPhased() / execute()               │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Agent (src/agent.ts)                           │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Paradigm Dispatch                        │   │
│  │  execute(): classifyIntent(flash) → routing decision        │   │
│  │    conversational/query → 临时切 appraise → 直接回答          │   │
│  │    task → setParadigm(p) → paradigmState.resolved            │   │
│  │      appraise ─▶ executeAsk()   (Q&A, lockDecouple)         │   │
│  │      ride ────▶ executeTarget() (完整工作流)                  │   │
│  │      spur ────▶ executeShoot()  (单文件精准)                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Core Loop: run()                         │   │
│  │  while iterations < max:                                    │   │
│  │    ├─ maybeCompress()          // 80% 阈值触发压缩           │   │
│  │    ├─ provider.streamToMessage()  // API 调用               │   │
│  │    ├─ executeToolCalls()       // 工具执行                  │   │
│  │    │   ├─ checkWrite()         // Horsewhip 边界检查        │   │
│  │    │   └─ recordWrite()        // 审计记录                  │   │
│  │    ├─ maybeUpdateSoul()        // 每3轮更新用户习惯          │   │
│  │    └─ timeout 处理 / abort 处理                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              所有范式: runPhased()                              │   │
│  │  ride → TargetExecutor (Clarify→Execute→Review)                │   │
│  │  appraise → lockDecouple → executeAsk() → unlock               │   │
│  │  spur    → lockIntent → executeShoot() → unlock                │   │
│  └─────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Horsewhip     │  │    Metrics      │  │   Reflector     │
│   (guard.ts)    │  │  (metrics.ts)   │  │ (reflector.ts)  │
│                 │  │                 │  │                 │
│ 边界管理模式:    │  │ 六维指标:       │  │ 违规检测:        │
│ ┌─────────────┐ │  │ ┌─────────────┐ │  │ ┌─────────────┐ │
│ │ decouple    │ │  │ │ 新增率       │ │  │ │ mild 超标    │ │
│ │ 全锁只读    │ │  │ │ recall 召回率│ │  │ │ severe >1.1x │ │
│ ├─────────────┤ │  │ │ lockBack锁回 │ │  │ ├─────────────┤ │
│ │ pasture     │ │  │ │ roundCount   │ │  │ │ 连续超标≥3次  │ │
│ │ allowlist   │ │  │ │ coupling合理 │ │  │ │ → 建议调阈值  │ │
│ │ strict/warn │ │  │ │ reuse 复用率 │ │  │ ├─────────────┤ │
│ └─────────────┘ │  │ └─────────────┘ │  │ │ 操作建议生成  │ │
│                 │  │                 │  │ └─────────────┘ │
│ 审计事件(JSONL): │  │ HITL累计(全量)  │  │                 │
│ write/unlock    │  │ 冗余检测         │  │ 反省违约检测:    │
│ lock/expand     │  │ 偷懒分类         │  │ 上次承诺 vs     │
│ strict_block    │  │ 反省违约检测     │  │ 本次实际        │
│ task_start/end  │  │                 │  │                 │
│                 │  │ 数据来源:        │  │                 │
│ cmd拦截:        │  │ session-audit   │  │                 │
│ tee/dd/cp/mv    │  │ .json (JSONL)   │  │                 │
│ touch/ln/sed -i │  │ reflection-audit│  │                 │
│ python/node -e  │  │                 │  │                 │
│ npm/git restore │  │                 │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## 二、三种范式工作流

### APPRAISE 模式 (相马)
```
  用户输入 ──▶ lockDecouple(全锁) ──▶ run() ──▶ unlock ──▶ 输出
  模型: flash  思考: 默认off (--thinking 可强制开启)  指标: no
  Horsewhip: 硬锁全只读
```

### SPUR 模式 (刺马)
```
  用户输入 ──▶ extractFilePaths() ──▶ lockIntent(指定文件)
          ──▶ run() ──▶ extractBlockedFiles() ──▶ unlock ──▶ 输出
  模型: pro  思考: 默认off (--thinking 可强制开启)  指标: no
  Horsewhip: 精准锁指定文件
```

### RIDE 模式 (策马 / Target)

```
  用户输入 ──▶ classifyIntent(flash) ──▶ conversational/query? → 直接回答
                    │ task
                    ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ CLARIFY (max 12轮)                                          │
  │ lockDecouple → 澄清对话 → GOAL_COMPLETE → 生成Plan          │
  │ Horsewhip: 全文件只读 (decouple)                            │
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ PLAN (硬门禁)                                                │
  │ lockIntent(.chitu/plans/) → 展示plan → 等待用户确认          │
  │ 仅 .chitu/plans/ 可写, 业务代码全锁                          │
  │ 用户输入 confirm → planConfirmed=true → 进入EXECUTE          │
  │ 用户反馈 → AI修订plan → 重新展示                              │
  │ --yunchang 模式 → 跳过确认, 直接进入EXECUTE                   │
  │ 持久化: .chitu/plans/plan-<project>.json (plan+state合并) + plan.md      │
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ EXECUTE (按拓扑序逐个sub-goal)                               │
  │                                                             │
  │ 硬门禁: planConfirmed 必须为 true, 否则退回PLAN               │
  │                                                             │
  │  ┌─── GROW ───────────────────────────────────────────┐    │
  │  │ lockIntent(targetFiles from plan) → AI coding      │    │
  │  │ 源码保护: 检测已完成子目标文件修改 → HITL 人在回路  │    │
  │  └────────────────────────────────────────────────────┘    │
  │                        │                                    │
  │                        ▼                                    │
  │  ┌─── TRIM ───────────────────────────────────────────┐    │
  │  │ getMetricFeedback(taskId, state) → 指标检查         │    │
  │  │ 文件数 < 10 → 跳过指标 / ≥ 10 → 强制检查            │    │
  │  │ severe (>10%超标) → 立即失败                        │    │
  │  │ mild (10%容忍带内) → 容忍计数, >3次 → 失败          │    │
  │  └────────────────────────────────────────────────────┘    │
  │                        │                                    │
  │                        ▼                                    │
  │  ┌─── VERIFY (3道硬门) ───────────────────────────────┐    │
  │  │ Gate 0: 空exports且无target文件 → fail (空产出)     │    │
  │  │ Gate 1: hasExport() 检查声明导出 → 写interface doc  │    │
  │  │ Gate 2: writeInterfaceDoc 写后回读parse验证         │    │
  │  │   verifyExportsExist() 逐文件交叉校验               │    │
  │  │   export缺失 → trim retry (最多MAX_RETRIES次)       │    │
  │  │ Gate 3: auto-commit (硬) → hash                    │    │
  │  │   commit失败 → 阻塞sub-goal推进, 返回错误            │    │
  │  │   commit成功 → 记录hash到 subGoal.committedHash     │    │
  │  │ 源码保护: 将targetFiles加入previousSubGoalFiles      │    │
  │  │ discardSubGoalContext → 下一sub-goal                │    │
  │  └────────────────────────────────────────────────────┘    │
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ REVIEW (3道硬门)                                             │
  │                                                             │
  │  Gate 1: npm test → fail? → AI修 → 重测                     │
  │  Gate 2: verifyAllInterfaceDocs() → 缺export? → AI修 → 重验 │
  │  Gate 3: finalMetricsCheck() → 超标? → AI修 → 重查          │
  │                                                             │
  │  全过 → unlock → DONE                                       │
  └─────────────────────────────────────────────────────────────┘
```

---

## 三、Ride 模式 (策马) 状态机

```
                      ┌─────────────┐
                      │   用户输入    │
                      └──────┬──────┘
                             │
                             ▼
                      ┌─────────────┐
                     ╱   CLARIFY    ╲
                    ╱  (目标澄清)     ╲
                   ╱   max 12 轮      ╲
                  ╱  全文件只读        ╲
                 ╱   ┌──────────────┐  ╲
                 │   │ 完整性检查    │   │
                 │   │ 提出澄清问题  │   │
                 │   │ → plan解析    │   │
                 │   └──────┬───────┘   │
                 └──────────┬──────────┘
                            │
                            ▼
                     ┌─────────────┐
                    ╱    PLAN      ╲   ← 硬门禁
                   ╱  (计划确认)    ╲
                  ╱  仅.chitu/plans/╲
                 ╱   可写,等用户确认  ╲
                ╱   confirm→进入执行  ╲
               ╱   反馈→AI修订plan     ╲
               └──────────┬──────────┘
                          │
                          ▼
                   ┌─────────────┐
                  ╱   EXECUTE    ╲
                 ╱  (逐步执行)    ╲
                ╱   按拓扑序       ╲
               ╱   逐个子目标       ╲
              ╱                    ╲
             ╱  ┌────────────────┐ ╲
             │  │ per sub-goal:  │  │
             │  │ lockIntent     │  │  ← 文件范围从plan.targetFiles派生
             │  │ GROW→TRIM→     │  │
             │  │ VERIFY→        │  │
             │  │ 写后回读验证    │  │  ← interface doc硬校验
             │  │ auto-commit    │  │  ← 失败阻塞sub-goal推进
             │  │ 记录commit hash│  │
             │  │ 源码保护→discard│  │
             │  │ → 下一个       │  │
             │  └────────────────┘  │
             │                     │
             │  触碰已完成子目标文件  │
             │  → HITL 人在回路     │
             │                     │
             │  全部完成 → REVIEW   │
             └──────────┬──────────┘
                        │
                        ▼
                 ┌─────────────┐
                ╱    REVIEW    ╲
               ╱   (硬门审查)   ╲
              ╱                 ╲
             ╱  Gate 1: npm test╲
            ╱   Gate 2: 接口验证 ╲
           ╱   Gate 3: 最终指标   ╲
          ╱                      ╲
         ╱   全部通过 → DONE      ╲
         └──────────┬─────────────┘
                    │
                    ▼
             ┌─────────────┐
             │    DONE     │
             │ unlock guard│
             └─────────────┘

状态持久化: .chitu/plans/plan-<project>.json (plan + state 合并, 扁平文件)
计划可读:   .chitu/plans/plan-<project>.md (人类可读)
接口文档:   .chitu/interfaces/interface-plan-<project>/sub-goal-<id>.md
路由索引:   .chitu/plan-router.json (只增不减, 管理所有plan)
```

### 约束链 (Constraint Chain)

赤兔 Target 模式的设计哲学：**约束不是提示，而是系统级门禁。** 每个阶段的可写范围由 Horsewhip 硬锁定，AI 不能绕过。

| 阶段 | Horsewhip 模式 | 可写范围 | 门禁 |
|------|---------------|---------|------|
| Clarify | decouple | 仅新文件 | 无 plan → 不能进入 Plan 阶段 |
| Plan | pasture | 仅 `.chitu/plans/` | 用户 `confirm` 才能进入 Execute；--yunchang 跳过确认 |
| Execute GROW | pasture per sub-goal | `plan.subGoals[N].targetFiles` | 文件范围从 plan 派生 |
| Execute TRIM | pasture per sub-goal | 同上 | 指标检查：severe → 立即失败；mild → 容忍3次 |
| Execute VERIFY | pasture per sub-goal | 同上 | Gate 0: 空 exports + 无文件 → 失败 |
|  |  |  | Gate 1: hasExport() 声明导出必须存在于 target files |
|  |  |  | Gate 2: writeInterfaceDoc 写后回读 parse + verifyExportsExist |
|  |  |  | Gate 3: auto-commit 失败阻塞 sub-goal 推进 |
|  |  |  | 源码保护：已完成文件的修改 → HITL 人在回路 |
| Review | decouple | 无（只读） | 三门禁全过才 unlock |

**Plan 是根约束：** 没有 plan.json 就没有 targetFiles，没有 targetFiles Horsewhip 就不解锁任何业务文件。Plan → Confirm → LockIntent → Commit 形成闭环绕。

---

## 四、Plan Router：只增不减的 Plan 管理体系

### 设计原则

Plan Router 是 Horsewhip "只增不减"原则在 plan 层的体现。Plan 永不删除，只标记状态（active → done / abandoned）。

```
┌─────────────────────────────────────────────────────────────────────┐
│                    .chitu/plan-router.json                          │
│                                                                     │
│  {                                                                  │
│    "entries": [                                                     │
│      { "id": "plan-accounting-app",                                 │
│        "goal": "创建一个记账程序",                                    │
│        "status": "active",                                          │
│        "subGoalCount": 5, "completedSubGoals": 3,                   │
│        "createdAt": "2026-06-01T...", "completedAt": null },         │
│      { "id": "plan-fix-login-bug",                                  │
│        "goal": "修改记账软件的登录逻辑",                               │
│        "status": "abandoned",                                       │
│        "subGoalCount": 2, "completedSubGoals": 1,                   │
│        "createdAt": "2026-06-02T...", "completedAt": "2026-06-02T..."}│
│    ],                                                               │
│    "activeId": "plan-accounting-app"  ← 当前活跃plan指针             │
│  }                                                                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐
│ .chitu/plans/   │  │ .chitu/plans/   │  │ .chitu/interfaces/       │
│ plan-accounting │  │ plan-fix-login  │  │ interface-plan-accounting│
│ -app.json       │  │ -bug.json       │  │   sub-goal-1.md         │
│ -app.md         │  │ -bug.md         │  │   sub-goal-2.md         │
│                 │  │                 │  │ interface-plan-fix-login │
│  plan+state     │  │  plan+state     │  │   sub-goal-1.md         │
│  合并为扁平文件  │  │  合并为扁平文件   │  └─────────────────────────┘
└─────────────────┘  └─────────────────┘
```

### 文件结构

```
.chitu/
  plan-router.json              ← 路由索引（append-only, 永不删除条目）
  plans/                        ← 扁平文件, 每个plan一个json+一个md
    plan-<slug>.json            ← plan + state 合并存储
    plan-<slug>.md              ← 人类可读的计划摘要
  interfaces/                   ← 按plan分文件夹
    interface-plan-<slug>/      ← 每个plan的接口文档文件夹
      sub-goal-1.md
      sub-goal-2.md
```

### 路由分发

```
  用户输入新任务
       │
       ▼
┌──────────────────────────────────────────┐
│  routeTask(provider, userTask, wsRoot)   │
│                                          │
│  调用 deepseek-v4-flash 做语义分类:        │
│                                          │
│  ┌──────────────┬──────────────────────┐ │
│  │ 返回          │ 行为                  │ │
│  ├──────────────┼──────────────────────┤ │
│  │ "new"        │ 新任务 → 创建新plan    │ │
│  │ "continue"   │ 继续当前 active plan  │ │
│  │ "resume:id"  │ 恢复指定 abandoned plan│ │
│  └──────────────┴──────────────────────┘ │
│                                          │
│  无router或路由失败 → 默认 "new"           │
└──────────────────────────────────────────┘
```

### 操作语义

| 操作 | 旧行为 | 新行为 |
|------|--------|--------|
| 创建新 plan | savePlan + saveState | 同上 + `registerPlan()` — 旧 active → abandoned |
| Plan 完成 | state.phase = "done" | 同上 + `completePlan()` — 标记 done, 清除 activeId |
| 新任务启动 | `rmSync` 删除旧 plan 目录 | `abandonPlan()` — 保留所有文件, 只改状态 |
| 项目名变更 | `rmSync` 删除旧目录 | `abandonPlan()` — 旧 plan 标记 abandoned |

### TUI 交互

```
输入 /plan-active
       │
       ▼
┌──────────────────────────────────────────┐
│  提示面板弹出所有 plan 列表                │
│                                          │
│  ● accounting-app  [active] 3/5  创建... │
│  ✓ fix-login-bug    [done]  2/2  修改... │
│  ○ refactor-api  [abandoned] 0/4  重构.. │
│                                          │
│  ↑↓ 选择, Enter 激活, /plan-active <id>   │
└──────────────────────────────────────────┘
       │ 选中某个 plan
       ▼
  ① registerPlan() → 标记为 active
  ② 自动切到 Ride 范式
  ③ 注入原始 goal 到消息中
  ④ executor.execute() 从断点继续
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/target/plan-router.ts` | PlanEntry 索引、CRUD、flash 路由分发、旧数据迁移 |
| `src/target/plan.ts` | Plan JSON 解析/生成/持久化、Goal 完整性检查 |
| `src/target/interface-doc.ts` | 子目标接口文档读写、export 交叉验证 |
| `src/target/executor.ts` | Ride 状态机, 通过 router 管理 plan 生命周期 |
| `src/routing.ts` | 语义路由: classifyIntent() 用 flash 分类用户意图 |

---

## 五、六大指标数据流

```
  AI工具调用
  (write_file, edit_file, delete_file, run_shell)
       │
       ▼
  ┌──────────────────────────────────────────────────────────┐
  │               Horsewhip Guard 审计                        │
  │                                                          │
  │  checkWrite() ──▶ strict_block 事件 (被拦截的写入)       │
  │  lockIntent() ──▶ file_unlocked 事件 (新增允许)          │
  │                 ──▶ file_locked 事件 (锁回)               │
  │                 ──▶ task_start 事件 (子目标标记)           │
  │  lockDecouple()──▶ file_locked 事件 (全部锁回)            │
  │  expandBoundary()─▶ user_expand 事件 (边界扩展)           │
  │  recordWrite() ──▶ write 事件 (isNew=true/false)         │
  │  checkMetrics   ──▶ human_in_loop 事件 (HITL触发)        │
  │  runPhased()    ──▶ phase_complete 事件 (grow/trim轮次)  │
  │                                                          │
  │  全部追加写入: .git/horsewhip/session-audit.json (JSONL)  │
  └────────────────────────────┬─────────────────────────────┘
                               │
                               ▼
  ┌──────────────────────────────────────────────────────────┐
  │              MetricsEngine.compute(taskId?)               │
  │                                                          │
  │  ① loadAuditEvents() — 读 JSONL (mtime缓存)             │
  │  ② groupByTask() — 按 task 字段分组                      │
  │  ③ 选目标task: taskId直接匹配 / completed优先 / 最多事件  │
  │  ④ getTrackedFiles() — git ls-files (mtime缓存)         │
  │                                                          │
  │  六大指标:                                                │
  │  ┌──────────────┬────────────────────────────────────┐   │
  │  │ 新增率        │ newFileWrites / totalWrites        │   │
  │  │              │ -1 = 无写入, >0 = 有新增即达标      │   │
  │  ├──────────────┼────────────────────────────────────┤   │
  │  │ 召回率        │ Σ(max(0,unlockCount-1)) / 总文件   │   │
  │  │              │ 跨task全量, 反复解锁=接口设计差     │   │
  │  ├──────────────┼────────────────────────────────────┤   │
  │  │ 锁回率        │ locks / unlocks (cap 1.0)          │   │
  │  │              │ 越接近1→越规范                       │   │
  │  ├──────────────┼────────────────────────────────────┤   │
  │  │ 回合数        │ phase_complete事件数               │   │
  │  │              │ 回退: unlocks+expands+blocks        │   │
  │  ├──────────────┼────────────────────────────────────┤   │
  │  │ 耦合合理度    │ 合理解锁 / 总解锁                   │   │
  │  │              │ classifyReason() 分类解锁理由       │   │
  │  ├──────────────┼────────────────────────────────────┤   │
  │  │ 复用率        │ hasModuleRefs() / newFileWrites    │   │
  │  │              │ -1 = 无新文件(不适用)               │   │
  │  └──────────────┴────────────────────────────────────┘   │
  │                                                          │
  │  附带:                                                   │
  │  - HITL累计数 (全量审计事件)                               │
  │  - 冗余检测 (detectRedundancy)                             │
  │  - 反省违约 (detectReflectionBreaches)                     │
  └────────────────────────────┬─────────────────────────────┘
                               │
                               ▼
  ┌──────────────────────────────────────────────────────────┐
  │                  Reflector 判定                           │
  │                                                          │
  │  前置: 源文件数 < 10 → 跳过全部指标检查                    │
  │  源文件数 ≥ 10 → 强制检查                                  │
  │                                                          │
  │  findMetricViolations()    → 一般超标 (mild, ≤10%容忍带)  │
  │  findSevereViolations()    → 严重超标 (>10% beyond)       │
  │  findRepeatedThresholds()  → 连续≥3次超标 → 建议调阈值    │
  │  generateSuggestions()     → 2-3条具体操作建议            │
  │                                                          │
  │  输出路径:                                                │
  │  - 源文件 < 10 → 跳过, 不检查                              │
  │  - 一般超标 → 容忍计数+1, >3次 → HARD FAIL                │
  │  - 严重超标 → 立即 HARD FAIL, 不进入容忍带                  │
  │  - 连续超标 → 建议用户调整 .chitu/config.json 阈值        │
  └──────────────────────────────────────────────────────────┘
```

### 六维指标阈值

| 指标 | 阈值 | 方向 | 严重度 | 含义 |
|------|------|------|--------|------|
| 新增率 (newFileRate) | — | — | warn | >0% 达标，=0% 触发反省 |
| 召回率 (recallRate) | 0.50 | high | error | 反复解锁文件的占比 |
| 锁回率 (lockBackRate) | 0.50 | high | warn | 解锁后又锁回的比例 |
| 回合数 (roundCount) | 8 | high | error | grow/trim 循环次数 |
| 耦合合理度 (coupling) | 0.60 | low | error | 解锁理由是合理耦合/接口/重构的占比 |
| 复用率 (reuseRate) | 0.30 | low | error | 新文件引用已有模块的比例 |

---

## 六、马鞭 (Horsewhip) 三层防护模型

```
  ┌─────────────────────────────────────────────┐
  │            Layer 1: decouple (解耦)          │
  │                                             │
  │  所有 git-tracked 文件 → 只读               │
  │  新文件 → 允许创建                           │
  │  Shell写入 → 拦截 (hasWriteConstruct)        │
  │  用途: Appraise模式, Ride的clarify/review阶段 │
  └──────────────────┬──────────────────────────┘
                     │ lockIntent() 缩小范围
                     ▼
  ┌─────────────────────────────────────────────┐
  │            Layer 2: pasture (牧场)           │
  │                                             │
  │  ┌───────┐  ┌──────────┐  ┌──────────────┐ │
  │  │ warn  │  │ strict   │  │ allowed(flat)│ │
  │  │ 自动放行│  │ 需显式匹配│  │ strict=null  │ │
  │  │ 不记录  │  │ 记录审计  │  │ 时的回退列表 │ │
  │  └───────┘  └──────────┘  └──────────────┘ │
  │                                             │
  │  package.json/tsconfig → auto-warn          │
  │  用途: Target sub-goal, Spur模式             │
  └──────────────────┬──────────────────────────┘
                     │ expandBoundary() 动态扩展
                     ▼
  ┌─────────────────────────────────────────────┐
  │          Layer 3: expand (边界扩展)          │
  │                                             │
  │  AI报告: "BLOCKED by Horsewhip. File: X"    │
  │       → expandBlockedFiles() 正则提取X       │
  │       → expandBoundary([X])                  │
  │       → 同时写入 allowed + strict            │
  │       → 重试 (retry loop)                    │
  │                                             │
  │  MCP inline expand: 2s超时则 block               │
  └─────────────────────────────────────────────┘
```

### 审计事件类型

| 事件类型 | 触发时机 | 审计字段 |
|---------|---------|---------|
| `write` | recordWrite() 调用 | file, isNew, task |
| `file_unlocked` | lockIntent() 新增允许文件 | file, reason, task |
| `file_locked` | lockIntent/lockDecouple 锁回 | file, reason, task |
| `strict_block` | checkWrite() 拦截写入 | file, reason, task |
| `user_expand` | expandBoundary() 扩展 | file, reason, task |
| `task_start` | lockIntent/lockDecouple/auditSubGoalStart | task |
| `task_complete` | taskComplete() | — |
| `phase_complete` | runPhased() grow/trim 轮次结束 | phase, round |
| `human_in_loop` | checkMetricsAndReflect() 严重超标 | phase, metrics |

---

## 七、上下文压缩机制

```
  ┌──────────────────────────────────────────────────────┐
  │  触发条件: estimatedTokens > 80% × MAX_CONTEXT_TOKENS │
  │  (MAX_CONTEXT_TOKENS = 80000, 阈值 = 80%)            │
  └────────────────────────┬─────────────────────────────┘
                           │
                           ▼
  ┌──────────────────────────────────────────────────────┐
  │  1. 保留最近 8 条消息 (keepCount = 8)                 │
  │  2. 滑动 start 指针跨过不完整的 tool_call/tool 对     │
  │  3. 归档被移除的消息 → .chitu/context/<ts>_<title>.json│
  │  4. 生成摘要: [User/AI/Tool] 各取前200/100字          │
  │  5. 重建 messages = [system, summary, ...recent8]     │
  └──────────────────────────────────────────────────────┘
```

---

## 八、MCP 工具清单

### 7.1 MCP Server 配置

唯一的 MCP Server: `horsewhip`，在 `src/mcp/loader.ts` 中加载。

配置来源（优先级）：
1. `.chitu/config.json` → `mcpServers.horsewhip`
2. `.mcp.json` (legacy fallback)

命名规则：`mcp__{serverName}__{toolName}` → 例如 `mcp__horsewhip__horsewhip_lock_intent`

### 7.2 进程内拦截工具（9 个）

这些工具由 `agent.ts` → `handleHorsewhipTool()` 直接路由到 `HorsewhipGuardImpl`，不经过 MCP 子进程。

| # | 完整工具名 | 用途 | 调用场景 |
|---|-----------|------|---------|
| 1 | `mcp__horsewhip__horsewhip_lock_intent` | 声明任务意图 + 文件清单，系统自动解析 strict/warn 分层 | Target sub-goal 开始时锁定目标文件 |
| 2 | `mcp__horsewhip__horsewhip_lock_decouple` | 解耦模式：所有 git 跟踪文件只读，仅允许新建 | Appraise 模式、Ride 的 clarify/review 阶段 |
| 3 | `mcp__horsewhip__horsewhip_lock_append_only` | 追加模式：老文件只读，可自由新建（实际路由到 lockDecouple） | `/horsewhip-lock` 命令 |
| 4 | `mcp__horsewhip__horsewhip_lock_paths` | 锁定指定文件路径（最小范围） | Spur 模式、精确边界控制 |
| 5 | `mcp__horsewhip__horsewhip_expand_boundary` | 动态扩展边界白名单 | AI 报告 blocked 文件后自动扩展 |
| 6 | `mcp__horsewhip__horsewhip_get_boundary` | 读取当前边界状态（lock 模式、allowlist） | 状态检查、调试 |
| 7 | `mcp__horsewhip__horsewhip_unlock` | 清除所有边界锁 | Appraise/Spur 结束、Ride review 通过 |
| 8 | `mcp__horsewhip__horsewhip_task_complete` | 标记任务完成，写入 task_complete 审计事件 | 任务正常结束时 |
| 9 | `mcp__horsewhip__horsewhip_record_write` | 记录文件写入审计事件 | write_file/edit_file/delete_file 后 |

### 7.3 转发到 MCP 子进程工具（6 个）

这些工具转发到 Horsewhip MCP 子进程执行，用于 UI 反馈、细粒度文件锁、自动提交。

| # | 完整工具名 | 用途 | 调用场景 |
|---|-----------|------|---------|
| 10 | `mcp__horsewhip__horsewhip_whip_ceremony` | VS Code 扩展中播放鞭子音效 + UI 反馈 | 锁定/扩展边界时视觉+听觉确认 |
| 11 | `mcp__horsewhip__horsewhip_suggest_scope` | 预览 lock_intent 的范围（干跑，不实际锁定） | 锁定前先看会影响哪些文件 |
| 12 | `mcp__horsewhip__horsewhip_lock_file` | 在追加模式下重新锁定单个已解锁文件 | 细粒度权限回收 |
| 13 | `mcp__horsewhip__horsewhip_unlock_file` | 在追加模式下解锁单个已有文件 | 细粒度权限授予 |
| 14 | `mcp__horsewhip__horsewhip_auto_commit` | 自动提交边界内变更 | `/horsewhip-auto` 流程 |
| 15 | `mcp__horsewhip__horsewhip_finish_auto` | task_complete + auto_commit 二合一 | `/horsewhip-lock-auto` 流程收尾 |

### 7.4 MCP 工具在三种范式中的使用

```
Appraise (相马):
  lock_decouple ──▶ (run...) ──▶ unlock

Spur (刺马):
  extractFilePaths ──▶ lock_paths ──▶ (run...) ──▶ expand_boundary ──▶ unlock

Ride (策马):
  lock_decouple ──────────────────────── (clarify阶段全锁)
    │
    └──▶ per sub-goal:
           lock_intent ──▶ (AI coding) ──▶ expand_boundary ──▶ record_write × N
              │
              └──▶ (review阶段) ──▶ task_complete ──▶ unlock
```

### 7.5 已修复问题

以下问题已在后续版本中修复：

- **MCP 工具名前缀**: `guard.ts` 中两处 `horsewhip__` 已改为 `mcp__horsewhip__`，inline expand 和 record_write 的 MCP 同步现已正常工作。
- **CLI 默认范式**: 从 `appraise` 改为 `ride`，`agent.run()` 改为 `agent.execute()`，CLI 新用户默认走完整 Ride 工作流。
- **Review allPassed**: 从单 bool 改为 per-gate 独立追踪，不再出现跨 gate 状态重置。
- **Implicit decouple**: 无 boundary 时不再全放行，已跟踪文件默认为只读。
- **思考模式增强**: 新增 `--thinking` CLI 标志和 `/deepthink` TUI 命令，允许用户在任何范式下显式启用深度思考。显式设置时跳过范式自动判断，强制使用 pro 模型。
- **TUI 思考提示**: 深度思考阶段显示 `chitu: 思考中...`，第一条正式回复到达时替换为 `chitu: [thinked]`，然后流式输出正文。
- **回复格式化**: 流式 Markdown 渲染 — `**粗体**` 亮黄、`*斜体*` 青色、`` `行内代码` `` 深灰底、`[链接](url)` 蓝下划线、`# 标题` 加白带前缀、`> 引用` 暗白、列表项彩色圆点/序号。
- **颜色方案**: AI 回复白色正文 + 红色 `chitu:` 前缀 + 用户输入区深灰背景底框（`\x1b[48;5;236m`）+ 回复正文 2 字符缩进。
- **Token 计数**: 跨轮次保持累计，`startStatusBar()` 不再将 `lastKnownUsage` / `animTokens` 归零，避免假跳水。
- **类型安全**: 消除全部 35 处 `as any` 类型绕过（生产代码零 `as any`）。Agent 新增 `getProviderName()`、`getDefaultModels()`、`getGuard()` 公共方法；HorsewhipGuardImpl 新增 `disabled` 属性。
- **错误处理**: 三处静默 `.catch(() => {})` 改为 `logger.warn(...)`，不再丢弃错误信息。
- **模块拆分**: `tui/app.ts` 从 1870 行减至 1707 行。提取 `visual.ts`（ANSI 工具）、`formatting.ts`（Markdown 渲染）、`banner.ts`（启动面板）三个独立模块。
- **Provider 优化**: 新增 `providers/sse.ts`（共享 SSE 流读取器）和 `providers/utils.ts`（公共工具函数）。修复 `providers/openai-compat.ts` 和 `providers/claude.ts` 中的 `as any` 转换。修复 `ClaudeProvider.streamToMessage` 缺少 `onReasoning` 参数。
- **测试覆盖**: 新增 `agent.test.ts`（22 个测试用例，覆盖构造/模型管理/思考模式/范式切换/消息管理/上下文监控/健康检查）。

---

## 九、关键文件索引

| 文件 | 职责 |
|------|------|
| `src/index.ts` | CLI 入口，解析参数，启动 TUI |
| `src/cli.ts` | CLI 参数解析、子命令路由（run/resume/metrics/list/build/sync） |
| `src/logger.ts` | 日志基础设施 |
| `src/auditor.ts` | 审计事件写入抽象（session-audit / reflection-audit） |
| `src/sync.ts` | Horsewhip MCP 版本同步 |
| `src/tui/app.ts` | 终端 UI：主事件循环、输入处理、状态栏、流式输出调度 |
| `src/tui/visual.ts` | ANSI-aware 字符串工具：CJK 宽度计算、截断、填充、面板绘制 |
| `src/tui/formatting.ts` | Markdown 格式化：粗体/斜体/代码/链接/标题/列表/引用 |
| `src/tui/banner.ts` | 启动横幅渲染：马图案 + 状态信息面板 |
| `src/tui/horse.ts` | ASCII 马图案渲染（大/小两种尺寸） |
| `src/tui/screen.ts` | 终端底层：ANSI 控制序列、颜色输出、滚动区域管理 |
| `src/agent.ts` | 核心 Agent：run() 主循环、runPhased() 阶段执行、execute() 范式调度 + 语义路由 |
| `src/routing.ts` | 语义路由层：classifyIntent() 用 deepseek-v4-flash 分类用户意图 (conversational/task/query) |
| `src/paradigm.ts` | 范式提示词：Appraise/Ride/Spur (相马/策马/刺马) 三种模式的 prompt 片段 |
| `src/target/plan-router.ts` | Plan 路由索引：PlanEntry CRUD、flash 路由分发、旧数据迁移、只增不减 |
| `src/target/plan.ts` | Plan 解析与持久化：JSON 生成/解析、Goal 完整性检查、扁平文件读写 |
| `src/target/executor.ts` | Ride 状态机：Clarify→Plan→Execute→Review，子目标 GROW→TRIM→VERIFY (4道硬门) |
| `src/target/interface-doc.ts` | 接口文档读写：export 交叉验证、上下文注入 |
| `src/horsewhip/guard.ts` | Horsewhip 边界管理：decouple/pasture 模式、checkWrite、审计事件 |
| `src/metrics.ts` | MetricsEngine：六维指标计算、审计事件加载、反省违约检测 |
| `src/reflector.ts` | 违规检测、严重超标判定、操作建议生成、连续超标检测 |
| `src/metrics-renderer.ts` | 指标报告渲染、AI 提示词生成、逐指标修正步骤描述 |
| `src/system-prompt.ts` | 系统提示词加载（多层组合） |
| `src/session.ts` | 会话管理：创建、保存、加载、列表 |
| `src/soul.ts` | 用户习惯管理：自动摘要、持久化 |
| `src/mcp/loader.ts` | MCP Server 加载、工具注册、命名空间前缀 |
| `src/mcp/client.ts` | MCP JSON-RPC 客户端，stdin/stdout 通信 |
| `src/tools/index.ts` | 工具注册：聚合所有 tool handlers |
| `src/tools/read.ts` | 读文件工具：read_file, web_fetch 等只读操作 |
| `src/tools/write.ts` | 写文件工具：write_file, edit_file, delete_file, run_shell |
| `src/tools/cli.ts` | 只读 shell 执行工具（cli_exec），拦截写入命令 |
| `src/tools/memory.ts` | 记忆系统工具：读写用户/项目记忆 |
| `src/tools/task.ts` | 任务管理工具：创建、更新、查询任务 |
| `src/tools/utils.ts` | 路径解析安全工具（resolvePath） |
| `src/providers/claude.ts` | Anthropic Claude API 适配器：消息格式转换、SSE 流解析 |
| `src/providers/openai-compat.ts` | OpenAI 兼容基类：DeepSeek、OpenAI 共用逻辑 |
| `src/providers/openai.ts` | OpenAI Provider（thin wrapper） |
| `src/providers/deepseek.ts` | DeepSeek Provider（thin wrapper） |
| `src/providers/factory.ts` | Provider 工厂：auto-detect 或手动选择 |
| `src/providers/sse.ts` | 共享 SSE 流读取器 |
| `src/providers/utils.ts` | Provider 公共工具函数 |
| `src/providers/types.ts` | Provider 接口、StreamEvent 类型 |
| `src/providers/index.ts` | Provider 模块导出 |
| `src/adapters/index.ts` | 环境适配器模块导出入口 |
| `src/adapters/env-detect.ts` | 环境检测：OS、Node 版本、Horsewhip 扩展状态 |
| `src/adapters/model-limits.ts` | 模型上下文限制、token 估算 |
| `src/adapters/version-check.ts` | Horsewhip 版本检查、更新提示 |
| `src/rollback/index.ts` | 回滚模块导出入口 |
| `src/rollback/anchor.ts` | 安全锚点：关键状态快照与回退 |
| `src/rollback/safe-mutation.ts` | 安全变更：文件操作前后状态记录 |
| `src/rollback/recovery.ts` | 故障恢复：自动回退到最近安全锚点 |
| `src/agent.test.ts` | Agent 核心单元测试（22 个用例） |

---

## 十、数据持久化文件

| 路径 | 内容 |
|------|------|
| `.git/horsewhip/boundary.json` | 当前边界锁状态 (locked/mode/allowed/strict/warn/task) |
| `.git/horsewhip/session-audit.json` | 审计事件 (JSONL) — 六大指标数据源 |
| `.git/horsewhip/reflection-audit.json` | AI 反省记录 (JSONL) |
| `.chitu/plan-router.json` | Plan 路由索引（append-only, 管理所有 plan 生命周期） |
| `.chitu/plans/plan-<slug>.json` | Ride 执行计划 + 状态机状态 (plan+state 合并, 扁平文件) |
| `.chitu/plans/plan-<slug>.md` | Ride 执行计划 (人类可读摘要) |
| `.chitu/interfaces/interface-plan-<slug>/sub-goal-<id>.md` | 子目标接口文档 |
| `.chitu/sessions/<uuid>.json` | 会话记录 |
| `.chitu/soul.md` | 用户习惯摘要 |
| `.chitu/config.json` | 项目配置 (MCP servers, techStack 等) |
| `.chitu/context/<ts>_<title>.json` | 压缩归档的上下文消息 |
| `.chitu/paradigm.json` | 上次使用的范式（跨会话持久化） |
