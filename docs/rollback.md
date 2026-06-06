# 衰退兜底机制（Rollback Safety Net）

> **可以任意向前冲，因为总能安全后退。**
>
> — Horsewhip 的精髓

赤兔的自适应自编程是一把双刃剑。能改自己，就有改坏自己的风险。**衰退兜底机制**就是那个兜住底的东西——每次自编程操作前自动创建安全锚点，事故自动回退，所有记录永久可查。

---

## 为什么需要它

自编程（self-programming）意味着赤兔能修改自己的源码。如果修改过程中出错：

1. 程序崩溃 → 无法定位事故点
2. 代码损坏 → 无法回退到可用状态
3. 日志丢失 → 不知道发生了什么

衰退兜底机制解决这三个问题：

| 问题 | 解决方案 |
|------|---------|
| 崩溃不可定位 | 每次变更写入审计链，事故记录带原因和涉及文件 |
| 无法回退 | 三层锚点（Git tag / 文件快照 / 审计链），秒级恢复 |
| 不知道发生了什么 | `.chitu/crashes.json` 永久保存事故记录，`.chitu/anchors.json` 保存所有锚点 |

---

## 三层锚点架构

```
L1 — Git Tag 锚点（秒级回退）
  ↓ 失效时
L2 — 文件快照锚点（文件级备份）
  ↓ 也失效时
L3 — 审计链锚点（永久变更追溯）
```

### L1 — Git Tag 锚点

最轻量、最快的回退方式。每次完美运行后自动打 tag：

```
git tag -f "anchor/优化上下文管理-1685432100000"
```

回退就是一条命令：

```
git reset --hard anchor/优化上下文管理-1685432100000
```

**前置条件**：当前无未提交的变更。有未提交变更时自动降级到 L2。

### L2 — 文件快照锚点

当有未提交变更或需要精确文件级回退时，备份指定文件到 `.chitu/snapshots/`：

```
.chitu/snapshots/snap-1685432100000/
├── src/agent.ts
├── src/adapters/index.ts
└── src/rollback/anchor.ts
```

回退时从快照目录复制回原位置。不涉及的文件不受影响。

### L3 — 审计链锚点

当 L1/L2 都不可用时（例如 .git 损坏、文件被删除），通过审计链追溯：

- 每条变更记录关联一个锚点 ID
- 每个锚点记录 commit hash、文件列表、操作时间
- 事故记录指向最近锚点，提供恢复建议

---

## 自动恢复流程

赤兔启动时自动执行健康检查：

```
启动 → healthCheck()
  ├─ 无事故 → ✅ 正常运行
  ├─ 有事故 + 可恢复 → planRollback() → executeRollback() → ✅ 已恢复
  ├─ 有事故 + 不可恢复 → ⚠️ 等待人工介入
  └─ 有事故 + 锚点丢失 → ❌ 记录到 crash.json，标记为不可恢复
```

`healthCheck()` 读取 `.chitu/crashes.json` 中的最新事故记录，判断是否有未恢复的事故。

---

## 持久化存储

所有数据存储在 `.chitu/` 目录下：

| 文件/目录 | 内容 | 用途 |
|-----------|------|------|
| `.chitu/anchors.json` | `AnchorPoint[]` | 所有锚点记录，按时间排序 |
| `.chitu/crashes.json` | `CrashRecord[]` | 所有事故记录，含原因和涉及文件 |
| `.chitu/health.json` | `HealthRecord` | 健康状态历史，含恢复次数 |
| `.chitu/snapshots/` | 文件快照 | 每次自编程前的文件备份 |

### AnchorPoint

```typescript
interface AnchorPoint {
  id: string;                      // 唯一锚点 ID
  label: string;                   // 人类可读标签
  createdAt: string;               // ISO 时间戳
  type: "git-tag" | "snapshot" | "milestone";
  severity: "safe" | "warning" | "critical";
  commitHash: string | null;       // Git commit hash
  tagName: string | null;          // Git tag 名称
  snapshotDir: string | null;      // 快照目录路径
  auditIds: string[];              // 关联的变更记录 ID
  metadata: Record<string, string>;
}
```

### CrashRecord

```typescript
interface CrashRecord {
  id: string;                      // 事故 ID
  happenedAt: string;              // 发生时间
  lastAnchorId: string | null;     // 事故前最后一个锚点
  description: string;             // 事故描述
  cause: string;                   // 推测原因
  recoverable: boolean;            // 是否可回退
  recommendedAction: string;       // 推荐动作
  affectedFiles: string[];         // 涉及文件
  changeset: string | null;        // 事故时的变更内容
}
```

---

## 自编程安全包装器

每次自编程操作都应该通过 `safeMutation()` 执行：

```typescript
import { safeMutation } from "../rollback/safe-mutation.js";

const result = await safeMutation({
  label: "优化上下文管理",
  files: ["src/agent.ts", "src/adapters/model-limits.ts"],
  autoRollback: true,     // 失败自动回滚
}, async () => {
  // 自编程操作
  await editAgentContext();
});
```

执行流程：

```
safeMutation()
  1. createSnapshot(files)    → 快照锚点
  2. await fn()               → 执行操作
     ├─ 成功 → createGitAnchor() → 返回结果
     └─ 失败 → recordCrash() → planRollback() → executeRollback() → 返回错误
```

---

## 关键文件

| 文件 | 功能 |
|------|------|
| `src/rollback/anchor.ts` | 锚点核心。L1/L2/L3 三层实现，锚点创建/查询/回滚 |
| `src/rollback/recovery.ts` | 自动恢复引擎。启动时 healthCheck() + autoRecover() |
| `src/rollback/safe-mutation.ts` | 自编程安全包装器。safeMutation() 自动锚点+回滚 |
| `src/rollback/index.ts` | 统一入口。导出所有公开接口 |
| `.chitu/anchors.json` | 持久化的锚点记录 |
| `.chitu/crashes.json` | 持久化的事故记录 |
| `.chitu/health.json` | 健康状态历史 |

---

## 维护指南

### 接手后第一件事

```bash
# 查看是否有未恢复的事故
cat .chitu/crashes.json

# 查看最近的锚点
cat .chitu/anchors.json | jq '.[-1]'

# 查看自恢复历史
cat .chitu/health.json
```

### 手动回滚到指定锚点

```bash
# 查看所有锚点
node -e "console.log(JSON.stringify(require('./.chitu/anchors.json'), null, 2))"

# 如果锚点是 git tag 类型
git reset --hard anchor/<标签名>

# 如果锚点是快照类型
cp -r .chitu/snapshots/<snapshot-id>/* src/
```

### 扩展新锚点类型

在 `src/rollback/anchor.ts` 中：

1. `AnchorPoint.type` 加新类型
2. 实现对应的创建函数
3. `planRollback()` 中加对应的回滚分支
4. `executeRollback()` 中加对应的执行分支

### 禁止操作

- ❌ 不要手动删除 `.chitu/anchors.json` — 所有锚点丢失
- ❌ 不要手动修改 `.chitu/crashes.json` — 审计链断裂
- ❌ 不要在自编程操作中跳过 safeMutation — 没有锚点保护
