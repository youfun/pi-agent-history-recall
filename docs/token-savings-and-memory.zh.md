# History Recall：Token 节省、甜点线与记忆角色

> 基于当前实现、设计文档与本仓库 session/index 实测的分析结论。  
> 历史是 **证据（evidence）**，不是事实；召回后仍需对工作树 verify。

---

## 1. 核心结论

| 问题 | 结论 |
|---|---|
| 理论上能省 token 吗？ | **能**，但是条件收益，不是自动开关 |
| 能加快速度吗？ | **能**，主要靠少 LLM tool-round，不是靠 SQLite |
| 越用越省吗？ | **对同一项目持续迭代：期望上是**；有平台期和老化期 |
| 有甜点线吗？ | **有**（任务类型 / 单次动作 / 时间 / 语料密度） |
| 能当记忆系统吗？ | **能当项目级过程与决策证据层**；不是通用长期记忆 |

一句话：

> 这是项目级「探索缓存 + 决策考古层」。  
> 省 token 是副作用；更核心的是减少重复探索和重复踩决策坑。

---

## 2. 为什么理论上能省

### 2.1 成本对比

冷启动：

```text
C_cold ≈ Σ(read/bash/grep 结果) + 多轮模型往返
```

History recall：

```text
C_hist ≈ C_search + C_read_hist + C_verify
```

当历史中已有可复用的路径、符号、约束、失败轨迹，且 agent 真的少做了摸索时：

```text
C_search + C_read_hist + C_verify  <  C_cold
```

### 2.2 期望收益公式

```text
E[Net] ≈
  P(hit) × 单次省下的探索
  − P(miss) × 小开销
  − P(mislead) × 带偏后的额外探索
  − 固定挂载税（工具描述 / AGENTS.md 等）
```

- `Net < 0`：省 token  
- 长期只要命中收益覆盖 miss/mislead/固定税，期望就为负（平均能省）

### 2.3 本仓库量级（实测口径）

估算：`tokens ≈ chars / 3.5`（代码 + 中英混合折中；真实 tokenizer 约 ×0.85–1.2）

| 项 | 大约 tokens |
|---|---:|
| 一次 `search` 命中（约 5 条） | 1.0k–1.5k |
| 一次 `search` 空结果 | ~35 |
| 一次 `read_project_history`（中等 chunk） | ~0.9k |
| 一次 `read_project_history`（大 trace） | ~2.6k |
| 典型有效召回包：1 search + 1 read_hist | **1.5k–4k** |
| 历史 session 中 `read` 结果 p50 | ~0.9k |
| 历史 session 中 `bash` 结果 p50 | ~0.2k |
| 固定工具描述 + guidelines + schema | 0.5k–0.9k / context |
| 项目 `AGENTS.md` | ~0.3k / context |
| 本地 search（约 110 chunks，warm） | ~20–35 ms（可忽略） |

盈亏平衡（微观）：

```text
1 search + 1 med read_hist ≈ 2k–4k tok
≈ 少读约 3 个中位文件 即可回本
```

场景示意（探索阶段 tool tokens，非整个 session）：

| 场景 | 约 Δtokens | 说明 |
|---|---:|---|
| 精准命中，避免大量 read/bash | **-6k 级** | 探索阶段可少约 50%–60% |
| 一般命中 | **-2k 级** | 约 20% |
| 弱命中后仍完整冷启动 | **+2k 级** | 纯附加成本 |
| 空结果 / 偶发误用 | **+几十** | 通常很小 |

说明：

- history 自身输出通常很便宜  
- 是否省，取决于有没有 **置换** 掉 explore 体积  
- 真正的速度收益往往来自 **少 1–3 个模型 tool-round（秒级）**

---

## 3. 越用越省：曲线，不是直线

### 3.1 正反馈

```text
使用越多
  → 覆盖的文件 / 模块 / 决策越多
  → 续作命中率上升
  → 平均更省、更快
```

会变好的：

- 同模块二次/三次改动更容易命中  
- 失败路径可复用（少走死胡同）  
- 约束、路径、符号沉淀为可检索线索  

会变差的：

- 过时 chunk 变多  
- 近重复会话增加噪声  
- 大 trace 直接灌进上下文变贵  
- 代码/需求演进后旧结论失效  

### 3.2 生命周期

```text
收益
  ^
  |          ╭──────── 平台期（甜点带）
  |        ╱
  |      ╱
  |    ╱
  |  ╱
  |╱____________________ 过时噪声拖累
  +-----------------------> 累积有效历史
   冷启动   形成期   成熟期   老化期
```

| 阶段 | 体感 |
|---|---|
| 冷启动 | 常空命中，偶尔略亏 |
| 形成期 | 开始正收益 |
| 成熟期 | 续作任务最省 |
| 老化期 | 不清理/不校验会变吵 |

关键指标不是 chunk 总数，而是：

```text
有效覆盖率 = 你常改的文件/决策 被历史覆盖的比例
```

---

## 4. 甜点线

### 4.1 单次动作甜

推荐：

```text
search → 1~2 个高相关 chunk → 2~4 次 verify read → 动手
```

不推荐：

```text
连搜多次空结果
读大量低相关大 trace
召回后仍全库 grep / 完整冷启动
```

### 4.2 任务类型甜

| 任务 | 是否甜点 |
|---|---|
| 续改旧模块 / 接上次设计 / 修回归 | **很甜** |
| “上次为啥这么定” / 历史决策追溯 | **很甜**（省的是方向，不只是 token） |
| 同项目相邻功能 | 较甜 |
| 全新子系统 / 仓库刚开始 | 不甜 |
| 纯格式化、单文件小改 | 通常不值得搜 |

### 4.3 时间甜

与当前设置一致（见 `settings` / `DESIGN.md`）：

| 窗口 | 含义 |
|---|---|
| 近 7 天（`freshnessHighDays`） | 续作最甜 |
| 7–30 天（`freshnessMediumDays`） | 仍有用，verify 更严 |
| 更久 | 更适合决策考古，不当当前事实 |

### 4.4 语料甜

| 阶段 | 体感 |
|---|---|
| 0–20 个有效 chunk | 冷 |
| 几十到几百，且集中在活跃模块 | **甜点带** |
| 大量近重复 / 过时会话 | 可能变吵，需 ranking / 清理 |

### 4.5 使用频率甜

- 每个相关续作任务：**0–1 次 search**  
- 需要细节：**再 1–2 次 `read_project_history`**  
- 避免：每轮盲目 search（固定税 + 污染后续上下文）

---

## 5. 记忆系统角色

### 5.1 定位

```text
L1 当前会话上下文     = 工作记忆
L2 history recall     = 项目过程 / 决策证据记忆
L3 代码 + 测试 + 文档 = 系统真相
```

正确闭环：

```text
L2 提供线索与历史决策
  → L3 verify
  → 新的过程再进入 L1/L2
```

### 5.2 像记忆的地方

| 类型 | 覆盖 | 机制 |
|---|---|---|
| 情景记忆（以前做过什么） | 强 | session / chunk / trace |
| 工作记忆外溢（上次探到哪） | 强 | files / symbols / steps |
| 决策记忆（当时为何这样选） | 中强 | user/assistant 原文 + constraints |
| 失败记忆（死胡同） | 强 | failed steps / exclusions |
| 业务规则线索 | 中 | constraints 抽取 |
| 用户偏好 / 人格记忆 | 弱 / 不做 | 非目标 |
| 跨项目记忆 | 不做 | project isolation |
| 自动维护的当前真相 | 不做 | evidence ≠ fact |

### 5.3 和 long-term AI memory 的边界

本扩展 **有意不做**：

- proactive memory writes  
- 跨项目推理  
- 用户偏好学习  
- 生成式摘要作为主存储  

因此它是：

```text
可检索的过程记忆 + 弱结构化决策线索
≠ 自动同步的系统真相记忆
```

更像「半自动、可检索的 ADR 草稿 + 探索笔记」，不是已审定架构决策库。

### 5.4 不能单独承担的职责

1. 不保证旧决策仍有效  
2. 不做 LLM 生成式“最终结论记忆”  
3. 不是永远在线的自动 memory layer（需主动 search/read）  
4. 不是偏好/身份记忆  

---

## 6. 什么时候不省，甚至更贵

| 情况 | 结果 |
|---|---|
| 全新功能、从无探索 | 空 search，净增很小 |
| 命中噪声 / query 偏 | 可能带偏，后面更贵 |
| 召回后仍完整冷启动 | history 变成附加成本 |
| 长 trace 原样灌入上下文 | `read_hist` 变贵 |
| 每轮盲目 search | 固定浪费 + 污染后续 turn |
| 无 prompt cache 时的固定工具描述 | 每轮多付固定税 |

另外，实现层面若出现：

- `read_project_history` 因 project 不匹配失败  
- 自动 hint（如设计中的 `before_agent_start`）未生效  

则“理论可省”的链路会在中途断开，实际省不到。

---

## 7. 如何量化（推荐口径）

### 7.1 单次任务 ledger

```text
NetΔtokens =
  Fixed_overhead
  + History_tool_tokens
  + Verify_tokens
  − Baseline_explore_tokens
```

记录：

```text
task | search_n | read_hist_n | hist_tok | verify_reads | avoided_reads | avoided_bash | net_tok | rounds | notes
```

### 7.2 A/B（最干净）

同一提示词、同一模型：

1. Control：`enabled=false`  
2. Treatment：启用 history  

对比：

- `input_tokens` / `output_tokens`（若有 usage）  
- tool result 总字符  
- model rounds  
- wall time  

### 7.3 从 session 事后估算

```text
hist_cost    = sum(history toolResult chars) / 3.5
explore_cost = sum(read/bash/grep toolResult chars) / 3.5
estimated_net = hist_cost − displaced_reads×870 − displaced_bashes×210
```

注意：若 history 很便宜但 explore 仍然巨大，只能说明“history 不贵”，不能直接证明“已经大幅省了”。

---

## 8. 实践建议

1. **优先用于续作、回归、追溯决策**，不要每次小改都搜。  
2. **一次 search 够用就停**；只 read 高相关 chunk。  
3. **永远 verify 当前代码**；把 history 当线索，不当 API。  
4. **重视决策与失败路径**，不只是文件路径。  
5. **定期依赖 freshness / ranking**；代码大改后降低对旧 chunk 的信任。  
6. **用 AGENTS.md 提醒 workflow**，但保持简短，避免固定税过大。  

推荐 workflow：

```text
search_project_history
  → read_project_history（1~2 个 chunkId）
  → read/verify 当前工作树
  → 修改
```

---

## 9. 总结表

| 维度 | 判断 |
|---|---|
| 理论能否省 token | 能 |
| 是否自动总省 | 否 |
| 是否越用越省 | 同一项目持续迭代时，期望上升并进入平台期 |
| 甜点 | 续作任务 + 少量召回 + 近期有效语料 + 严格 verify |
| 记忆角色 | 项目过程/决策证据层（L2），不是 L3 真相，也不是通用长期记忆 |
| 最大价值 | 少重复探索、少重复踩决策坑；token 与速度是伴随收益 |

---

## 10. 相关文档

- [README.zh.md](../README.zh.md) — 安装、工具、命令  
- [DESIGN.md](../DESIGN.md) — 架构、索引、检索、非目标  
- [AGENTS.md](../AGENTS.md) — agent 使用约定  
