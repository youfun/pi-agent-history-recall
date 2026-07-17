# pi-agent-history-recall

Pi 扩展：**项目对话检索**。

它从 **Pi Session JSONL** 中恢复过往工作，使代理在长期项目中减少重复 grep、重复阅读和重复推导设计意图。

```text
Session JSONL  →  可丢弃的 SQLite 索引  →  搜索/读取工具
     (唯一真相来源)       (可重建)             (证据，不是事实)
```

**历史是证据，不是事实。**  
召回后，代理在修改任何内容之前，仍然需要先验证当前代码。

不是长期 AI 记忆产品。不是第二个聊天数据库。不是用户偏好的知识库。

---

## 目标

降低 **探索成本**，而不是上下文 token。

当用户说类似下面的话时：

> 更新 README 的更新说明
> 为扩展增加 rebuild 子命令
> 修改项目隔离规则

代理应该能够：

1. 搜索本项目的历史会话
2. 恢复相关文件、符号、约束、排除项和探索轨迹
3. 读取并验证工作区中的当前文件
4. 仅在验证后才进行修改

理想结果：减少全仓库 grep，减少对心理模型的冷启动。

---

## 安装

从当前包目录安装：

```bash
pi install .
```

或者链接/注册包，让 Pi 加载：

```json
"pi": {
  "extensions": ["./src/index.ts"]
}
```

要求：

- [Pi coding agent](https://github.com/badlogic/pi-mono)（使用 `@earendil-works/pi-coding-agent`）
- Bun 或 Node，带 SQLite（FTS5）
- 已有 Pi 会话位于 `~/.pi/agent/sessions/`

---

## 工具

| 工具 | 用途 |
|------|---------|
| `search_project_history` | 当前项目的排名 **对话块** |
| `read_project_history` | 完整块：用户文本、助手文本、探索轨迹、实体、约束 |
| `history_search` | `search_project_history` 的别名 |

### `search_project_history`

```ts
{
  query: string;           // 自然语言或关键词（支持 CJK）
  maxResults?: number;     // 默认 5，最大 20
  minRelevance?: number;   // 默认 40
  minConfidence?: number;  // 默认 30
}
```

每个结果包含：

| 字段 | 含义 |
|-------|---------|
| **Relevance** | 词汇/实体匹配强度（0–100） |
| **Confidence** | 证据的可信度（轨迹完整性、配对情况等） |
| **Freshness** | 按块年龄划分的 `High` / `Medium` / `Low` |
| files / symbols | 提取的路径和标识符 |
| constraints / exclusions | 保守的规则性句子和“排除了……”步骤 |
| `chunkId` | 传给 `read_project_history` |
| sibling variants | 同一用户轮次的其他分支变体（未合并） |

### `read_project_history`

```ts
{
  chunkId: string;
}
```

返回一个块的完整探索路径：工具序列、实体、约束和来源条目 id。  
**不会**向模型返回绝对会话文件路径。

### 推荐的代理工作流

```text
search_project_history
        ↓
read_project_history（针对有希望的 chunkId）
        ↓
读取 / 验证工作区中的当前文件
        ↓
修改
```

工具提示中编码了：**不要把历史当作当前真相**。

---

## 命令

```text
/history-recall <query>
/history-recall settings
/history-recall status
/history-recall rebuild
/history-recall clear
/history-recall on | off
/history-recall help
```

| 子命令 | 用途 |
|------------|---------|
| `<query>` | 搜索本项目的历史 |
| `settings` | 交互式 TUI 设置覆盖（类似 pi-context-prune） |
| `status` | 设置 + 索引路径 + 诊断 |
| `rebuild` | 删除可丢弃的 SQLite 索引并重新索引会话 |
| `clear` | 仅删除可丢弃的 SQLite 索引（Session JSONL 不受影响） |
| `on` / `off` | 通过用户设置启用/禁用 |
| 裸 `/history-recall` | 子命令选择器 |

示例：

```text
/history-recall README update
/history-recall session index rebuild
/history-recall project isolation
/history-recall status
```

日常搜索和读取时会自动增量 reconcile；只有全量重置才需要手动 `rebuild`。

---

## 行为 (v1)

| 领域 | 行为 |
|------|----------|
| **数据来源** | 仅 Pi Session JSONL |
| **索引** | SQLite + FTS5，可丢弃且可重建；搜索/读取会自动增量 reconcile |
| **项目隔离** | `canonical_cwd = NFC(realpath(cwd))`，`project_id = SHA-256(canonical_cwd)`；会话 `header.cwd` 必须匹配 |
| **检索单元** | 对话块（用户 → 助手/工具 → 一个分支路径上的结果） |
| **分支** | 同级变体永远不会合并；超限构建 **fail closed** 并保留旧版本 |
| **搜索** | 双 FTS（Latin + CJK n-grams），路径/符号/错误提升 |
| **排名** | 三个维度：Relevance、Confidence、Freshness |
| **探索轨迹** | read / grep / find / list / bash / edit / write / error / exclusion / verification |
| **隐私** | 密钥脱敏；敏感路径过滤；工具输出尽可能使用项目相对路径 |
| **并发** | 文件系统 writer lease，防止两个 Pi 进程让旧快照覆盖新索引 |
| **重建策略** | `rebuild` 是手动全量重置；正常使用不需要 |

---

## 索引位置

优先（当项目目录可写时）：

```text
{project}/.pi/history-recall.sqlite
```

回退：

```text
~/.pi/agent/history-recall/<project_id>.sqlite
```

相关文件（同样可丢弃）：

```text
*.sqlite-wal
*.sqlite-shm
*.sqlite.lock
```

随时可以安全删除。下一次 reconcile 会从 Session JSONL 重建。  
**绝不要**删除 session JSONL 来替代清除索引。

会话发现于：

```text
~/.pi/agent/sessions/--<encoded-cwd>--/
```

编码遵循 Pi 的会话目录规则。目录名只是发现提示；**header.cwd** 才是真正的隔离门控。

---

## 设置（可选）

设置合并顺序（后者胜出）：

1. 内置默认值
2. 用户：`~/.pi/agent/history-recall/settings.json`
3. 项目：`{cwd}/.pi/history-recall.json`

项目文件示例：

```json
{
  "enabled": true,
  "minRelevance": 40,
  "minConfidence": 30,
  "freshnessHighDays": 7,
  "freshnessMediumDays": 30
}
```

| 键 | 含义 |
|-----|---------|
| `enabled` | 该范围的主开关 |
| `freshnessHighDays` / `freshnessMediumDays` | 新鲜度桶 |

项目文件中的 `enabled: false` 是针对该仓库的预期 opt-out 方式。

---

## 架构（简略）

```text
Pi Session JSONL
      │
      ▼
 session/ingest     树 + header.cwd 隔离 + 双 fstat 快照
      │
      ▼
 chunk/builder      分支安全的对话块（+ fail-closed 限制）
      │
      ├─ extract/*   实体、约束、探索轨迹、CJK grams
      ▼
 index/store         SQLite schema、双 FTS、writer lease、增量指纹
      │
      ▼
 retrieve/*          BM25 + boosts → Relevance / Confidence / Freshness
      │
      ▼
 tools + /history-recall
```

深度设计、验收标准和非目标：**[DESIGN.md](./DESIGN.md)**。

Token 节省、甜点线与记忆角色分析：**[docs/token-savings-and-memory.zh.md](./docs/token-savings-and-memory.zh.md)**。

---

## 更新

没有独立的 update 命令。更新此扩展的方法是重新加载扩展代码，然后按需重建索引。

**本地开发仓库**

```bash
cd /Users/box/dev-code/pi-agent-history-recall
git pull
bun install
bun test
bun run typecheck
```

如果 Pi 从当前目录加载，更新源码后请重启 Pi。

**重新安装包**

```bash
pi install .
```

**更新后重建索引**

仅在需要全量刷新或删除索引文件后执行。

```text
/history-recall rebuild
```

或者先验证当前状态：

```text
/history-recall status
```

SQLite 索引是可丢弃的；随时可以从 Session JSONL 安全重建。

日常搜索和读取时会自动增量 reconcile，正常使用不需要手动 rebuild。

---

## 开发

```bash
bun install
bun test          # 验收矩阵 + 单元测试
bun run typecheck
```

布局：

```text
src/
  index.ts              # 扩展入口
  config.ts             # 设置读写
  project.ts            # 项目身份 + 索引路径
  privacy.ts            # 脱敏 / 路径显示
  session/ingest.ts     # JSONL 解析 + 会话发现
  chunk/builder.ts      # 对话块构建
  extract/              # CJK、实体、约束、探索
  index/                # schema、store、FTS、lease、db adapter
  retrieve/             # 搜索 + 排名
  tools/                # 搜索 / 读取工具
tests/                  # 测试夹具 + 验收矩阵
DESIGN.md               # 完整规范
```

---

## 隐私与安全

- 脱敏常见 API 密钥、token、PEM 块和类凭证赋值
- 跳过敏感路径名（如 `.env`、`credentials.json`、私钥）
- 工具输出尽可能使用项目相对路径
- 不会为模型生成绝对 `~/.pi/agent/sessions/...` 路径
- 扩展生成的提示不得成为主要检索语料（参见 DESIGN；保持索引不受自提示循环污染）

---

## 非目标 (v1)

- Embedding / 向量搜索
- 知识图谱
- 跨项目推理
- 代理写入长期记忆（`learn` / consolidate）
- 将所有聊天总结为知识库
- 自动学习用户偏好
- 用召回的历史替代验证

---

## 灵感来源（边界）

| 项目 | 关系 |
|---------|---------|
| **cog-cli** | 长期代理记忆 — **目标不同**。我们检索项目会话；我们不学习 engram。 |
| **pi-context-prune** | 同会话上下文压缩 — 有用的工程模式（批量捕获、工具）。我们索引 **项目级** 历史，而不仅是实时上下文窗口。 |

参考检出可能位于 `vendor/`（gitignored）。

---

## 许可证

MIT
