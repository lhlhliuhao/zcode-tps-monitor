# ZCode TPS Monitor Token 统计架构重构实施计划

> 文档版本：v1.0  
> 规划日期：2026-09-14  
> 目标项目：`shy3130/zcode-tps-monitor`  
> 实施方式：后续在真实 Windows / ZCode 环境中由 Agent 按本计划逐阶段执行  
> 原则：先审计、再重构；每阶段可独立验证；禁止一次性大范围修改后再排错。

---

## 1. 项目目标

本次重构不是简单增加几个 Token/Cache 字段，而是统一整个插件的统计架构。

### 1.1 必须达到的目标

1. Token 统计功能本身不向模型上下文注入统计信息。
2. Token 统计功能不要求模型执行任何额外命令。
3. Token 监控不得为了自身统计目的触发额外模型请求或工具调用。
4. 所有 Token 统计统一来自 ZCode 自身 `model_usage` 数据。
5. 建立唯一的 Token Statistics Core。
6. Dashboard、Windows Overlay、Stop Hook、CLI、MCP 全部使用同一个统计核心。
7. 同时支持：
   - Request 级统计
   - Turn 级统计
   - Session 级统计
8. 增加真实可用的 Input / Cache Read / Cache Hit Rate 等指标。
9. 不假设数据库中存在不存在的 Cache 字段。
10. 修复当前历史曲线窗口、Session 统计口径等已发现问题。
11. 保持 SQLite 只读，不修改 ZCode 数据库。
12. Windows Overlay 继续保留，不改变其现有定位、主题、DPI、拖动等功能。
13. 任何单个统计功能异常，都不能影响 ZCode 正常对话。

---

# 2. 最终目标架构

```text
                         ZCode
                           |
                           v
                    model_usage SQLite
                           |
                      read-only
                           |
                           v
                 +---------------------+
                 | Token Statistics    |
                 | Core                |
                 |                     |
                 | Request             |
                 | Turn                |
                 | Session             |
                 | Cache               |
                 +----------+----------+
                            |
          +-----------------+------------------+
          |                 |                  |
          v                 v                  v
      Dashboard         Stop Hook            CLI/MCP
          |                 |                  |
          v                 v                  |
       Overlay          systemMessage          |
                                               |
                                               v
                                         用户主动查询
```

核心原则：

> Model 不参与 Token Monitor 的统计过程。

---

# 3. 当前实现审计结论

## 3.1 `prompt-submit.mjs` 当前问题

当前 UserPromptSubmit：

1. 写入 sessionId / timestamp。
2. 调用 `query()`。
3. 通过 `additionalContext` 注入上一轮 Token 统计。
4. 注入 `TURN_STATS_INSTRUCTION`。
5. 要求模型在特定情况下执行：
   `token-rate.mjs --turn --current`
6. 要求模型将结果复制到回答末尾。

这违反“监控零模型 Token 侵入”的最终目标。

### 必须删除

- `additionalContext` 中的 Token 统计。
- `TURN_STATS_INSTRUCTION`。
- `token-rate.mjs` 在模型上下文中的命令调用要求。
- `prompt-submit.mjs` 对 `query()` / `formatLine()` 的依赖。

### 保留

UserPromptSubmit 只负责记录当前 Session / Prompt 时间状态，若经过验证发现这些状态可以由其他 Hook 或数据库直接推导，也可以进一步减少。

---

## 3.2 `session-start.mjs` 当前问题

当前 SessionStart 通过 `additionalContext` 向模型注入插件说明。

目标是：

- 不再向模型注入插件提示。
- SessionStart 仅记录 Session 状态，或者在确认 Dashboard 可以直接确定当前 Session 后取消状态写入。

SessionStart 本身不应成为 Token Monitor 的模型上下文来源。

---

## 3.3 `stop.mjs` 当前路线正确

当前 Stop Hook：

```text
Stop
  -> queryTurn()
  -> formatTurnLine()
  -> systemMessage
```

这是目标架构应该保留的路线。

但必须把 `queryTurn()` 移到统一 Token Statistics Core。

Stop Hook 只负责：

1. 获取 session_id。
2. 等待 usage 数据写入。
3. 请求 Core 获取最新 Turn。
4. 输出 `systemMessage`。
5. 异常静默退出。

---

# 4. 当前 `token-rate.mjs` 已确认的问题

## 4.1 HIST 与 N 混用

当前逻辑先查询 `HIST`，随后：

```js
histRows.slice(0, N)
```

导致历史数据实际最多只有 N 条。

默认：

```text
N = 5
HIST = 60
```

因此 `TOKEN_RATE_HIST=60` 不能真正提供 60 个历史点。

### 修复要求

必须拆分：

```text
historyLimit
windowSize
```

其中：

- `HIST`：Dashboard 历史曲线点数。
- `N`：近 N 次请求统计窗口。

两者不能互相截断。

---

## 4.2 Session 对象混合不同统计范围

当前：

```text
samples / avg / max / min
```

来自最近 N 条有效请求。

而：

```text
totalOutput
totalReasoning
totalInput
totalCacheRead
```

来自整个 Session。

这会造成一个字段对象内部统计范围不一致。

### 修复

明确拆成：

```json
{
  "window": {},
  "session": {}
}
```

---

# 5. 统一统计层级

## 5.1 Request

一条 `model_usage` 记录对应一个 Request。

标准字段：

```text
model
turnId
inputTokens
cacheReadInputTokens
uncachedInputTokens
cacheHitRate
outputTokens
reasoningTokens
generationTokens
firstTokenAt
completedAt
ttftMs
generationMs
tokPerSec
valid
```

### 生成 Token 定义

```text
generationTokens =
    outputTokens + reasoningTokens
```

### Request tok/s

```text
tokPerSec =
    generationTokens / generationMs * 1000
```

仅当：

```text
generationMs >= MIN_GEN_MS
generationMs < MAX_GEN_MS
generationTokens > 0
```

时认为有效。

---

# 6. Turn 统计

一个用户 Prompt 对应一个 `turn_id`，一个 Turn 可以包含多个 Model Request。

例如：

```text
User Prompt
  |
  +-- Request 1
  |     -> Tool
  |
  +-- Request 2
  |     -> Tool
  |
  +-- Request 3
        -> Final
```

Turn 必须聚合全部属于该 Turn 的有效 Request。

### Turn Token

```text
generationTokens =
    Σ(outputTokens + reasoningTokens)
```

### Turn 生成时间

```text
generationMs =
    Σ(request.generationMs)
```

工具等待时间不计入纯生成吞吐率。

### Turn tok/s

```text
tokPerSec =
    totalGenerationTokens / totalGenerationMs * 1000
```

### Turn Peak

```text
peak =
    max(request.tokPerSec)
```

---

# 7. Session 统计

Session 是多个 Turn 的集合。

建议输出：

```text
requests
turns

inputTokens
cacheReadInputTokens
uncachedInputTokens
cacheHitRate

outputTokens
reasoningTokens
generationTokens

generationMs
weightedTokPerSec
```

---

# 8. Request Average 与 Weighted Rate 必须区分

不能只保留一个 `avg`。

## 8.1 算术平均

```text
avgTokPerSec =
    average(request.tokPerSec)
```

反映“平均一次请求的速度”。

## 8.2 加权综合速度

```text
weightedTokPerSec =
    Σ generationTokens
    /
    Σ generationMs
    * 1000
```

反映整个生成时间窗口的实际综合吞吐。

两者都保留，不能互相替代。

---

# 9. Cache 统计

第一阶段只使用实际存在于 ZCode 数据库中的字段。

目前已确认：

```text
input_tokens
cache_read_input_tokens
```

## 9.1 Input Tokens

```text
inputTokens
```

## 9.2 Cache Read Input Tokens

```text
cacheReadInputTokens
```

## 9.3 Uncached Input

如果确认 `input_tokens` 是完整输入量：

```text
uncachedInputTokens =
    max(0, inputTokens - cacheReadInputTokens)
```

## 9.4 Cache Hit Rate

```text
cacheHitRate =
    cacheReadInputTokens / inputTokens * 100
```

当：

```text
inputTokens <= 0
```

时：

```text
cacheHitRate = null
```

---

# 10. Cache 聚合原则

不能对 Request Cache Hit Rate 做简单平均。

错误：

```text
average(request.cacheHitRate)
```

正确：

```text
Turn Cache Hit Rate =
    Σ cacheReadInputTokens
    /
    Σ inputTokens
    * 100
```

Session 同理。

---

# 11. Cache Write / Output Cache

在没有完成数据库 Schema 审计之前：

- 不假设 `cache_write_input_tokens` 存在。
- 不假设 `cache_creation_input_tokens` 存在。
- 不假设 `output_cache_tokens` 存在。
- 不在 UI 中虚构这些指标。

Phase 1 必须通过：

```sql
PRAGMA table_info(model_usage);
```

确认完整 Schema。

如果确实存在真实字段，再设计第二阶段扩展。

---

# 12. Session 状态文件重构

当前：

```text
~/.zcode/tps-monitor.last-session.json
```

同时承担：

- 当前 Session
- Prompt 时间
- Stop 时间
- `--current` 守卫
- Dashboard follow

职责过多。

建议拆成：

```text
~/.zcode/tps-monitor/
├── active-session.json
└── prompt-state.json
```

## active-session.json

```json
{
  "sessionId": "...",
  "updatedAt": 123456789
}
```

## prompt-state.json

```json
{
  "sessionId": "...",
  "promptAt": 123456789
}
```

只有 UserPromptSubmit 修改 `prompt-state.json`。

Stop Hook 不得覆盖 Prompt 时间。

---

# 13. `--current` 处理原则

正式统计链路不再依赖：

```text
--current
```

因为不再要求模型调用 CLI。

可以暂时保留：

```text
CLI 调试/兼容
```

但正式路线：

```text
Stop Hook
  -> payload.session_id
  -> latestTurn
```

不再使用 Prompt 时间戳推断当前 Turn。

---

# 14. Token Statistics Core

建议新增：

```text
plugins/zcode-tps-monitor/scripts/token-stat-core.mjs
```

它是整个系统唯一统计核心。

建议 API：

```js
getLatestRequestStats(sessionId)
getLatestTurnStats(sessionId)
getWindowStats(sessionId, size)
getSessionStats(sessionId)
getHistory(sessionId, limit)
getAllStats(sessionId, options)
```

---

# 15. Core 的内部处理流水线

必须采用：

```text
SQLite Raw Row
       |
       v
Normalize
       |
       v
Validate
       |
       v
RequestStats
       |
       +------> Request
       |
       +------> Turn
       |
       +------> Window
       |
       +------> Session
       |
       +------> History
```

不要让 Dashboard / Hook / CLI 自己重新解释数据库字段。

---

# 16. 建议统一 DTO

最终 `getAllStats()`：

```json
{
  "schemaVersion": 1,
  "sessionId": "...",

  "latestRequest": {
    "model": "...",
    "tokPerSec": 320.5,
    "outputTokens": 2500,
    "reasoningTokens": 300,
    "generationTokens": 2800,
    "inputTokens": 18000,
    "cacheReadInputTokens": 14000,
    "uncachedInputTokens": 4000,
    "cacheHitRate": 77.78,
    "ttftMs": 820,
    "generationMs": 7800
  },

  "latestTurn": {
    "turnId": "...",
    "requests": 3,
    "ratedRequests": 3,
    "tokPerSec": 335.2,
    "peakTokPerSec": 450.8,
    "outputTokens": 4500,
    "reasoningTokens": 500,
    "generationTokens": 5000,
    "inputTokens": 32000,
    "cacheReadInputTokens": 25000,
    "uncachedInputTokens": 7000,
    "cacheHitRate": 78.13,
    "ttftMs": 820,
    "generationMs": 14900
  },

  "window": {
    "size": 5,
    "samples": 5,
    "avgTokPerSec": 310.2,
    "weightedTokPerSec": 325.4,
    "minTokPerSec": 240.1,
    "maxTokPerSec": 450.8
  },

  "session": {
    "requests": 27,
    "turns": 12,
    "inputTokens": 95000,
    "cacheReadInputTokens": 72000,
    "uncachedInputTokens": 23000,
    "cacheHitRate": 75.79,
    "outputTokens": 12000,
    "reasoningTokens": 1800,
    "generationTokens": 13800,
    "generationMs": 41000,
    "weightedTokPerSec": 336.59
  },

  "history": []
}
```

字段名称以实际 Schema 审计结果为最终依据。

---

# 17. `token-rate.mjs` 的定位

不要立即删除。

改造成：

```text
token-rate.mjs
       |
       v
token-stat-core.mjs
```

它只负责：

- CLI 参数解析
- 人类可读格式化
- JSON 输出
- 调用 Core

不能再自己维护第二套统计逻辑。

---

# 18. Dashboard 改造

当前：

```text
/api/token-rate
    -> query()
```

改成：

```text
/api/token-rate
    -> getAllStats()
```

Dashboard 前端不重新计算 Token rate。

直接消费：

```text
latestRequest
latestTurn
window
session
history
```

---

# 19. Dashboard 推荐显示

## 当前 Request

```text
Model
320 tok/s

Output       2.5K
Reasoning     300
Input         18K
Cache Read    14K
Cache Hit     77.8%

TTFT          820ms
Generation    7.8s
```

## 当前 Turn

```text
335 tok/s
3 requests

Output       4.5K
Reasoning    500
Input        32K
Cache Read   25K
Cache Hit    78.1%
```

## Session

```text
Requests      27
Turns         12

Avg           310 tok/s
Weighted      337 tok/s
Max           451 tok/s

Input         95K
Cache Read    72K
Cache [... ELLIPSIZATION ...]ow
- Topmost 行为
- 每秒刷新
- ZCode 右下角相对定位

继续使用：

```text
http://127.0.0.1:7423/api/token-rate
```

只扩展数据展示。

推荐短格式：

```text
⚡ 320 tok/s | Avg 310 | Cache 78% | TTFT 820ms
```

空间不足时不要显示全部指标。

---

# 21. Stop Hook

最终：

```text
Stop
  |
  +-- 获取 session_id
  |
  +-- 短暂等待 model_usage 写入
  |
  +-- getLatestTurnStats(sessionId)
  |
  +-- systemMessage
```

不得：

- 注入 additionalContext
- 调用模型
- 要求模型转发
- 修改 SQLite
- 影响主回复

建议保留短重试：

```text
250ms × 最多 5 次
```

但后续真机验证如果 ZCode 已经保证 usage 写入顺序，可以进一步减少等待。

---

# 22. SessionStart Hook

改成：

```text
SessionStart
   |
   +-- 记录 active-session（如果确实需要）
   |
   +-- 不输出 additionalContext
```

不得向模型注入插件说明。

帮助信息应放到：

- README
- Dashboard
- `/tps`
- `/tps-doctor`
- MCP
- 用户主动查询

---

# 23. UserPromptSubmit Hook

最终目标：

```text
UserPromptSubmit
   |
   +-- 记录 prompt-state（仅在 --current 兼容需求存在时）
   |
   +-- exit 0
```

不要：

```text
query()
formatLine()
additionalContext
TURN_STATS_INSTRUCTION
```

如果后续验证不再需要 `prompt-state.json`，整个 Hook 可以进一步简化。

---

# 24. MCP

MCP 必须调用 Core。

建议提供：

```text
get_token_rate
get_request_stats
get_turn_stats
get_session_stats
get_cache_stats
```

所有返回结果与 Dashboard 完全一致。

禁止 MCP 自己重新查询和计算。

---

# 25. Slash Commands

现有：

```text
/tps
/tps-doctor
```

继续保留。

其中：

```text
/tps
```

调用 Core。

```text
/tps-doctor
```

检查：

1. Node 版本。
2. `node:sqlite`。
3. DB 路径。
4. DB 是否可读。
5. `model_usage` 是否存在。
6. 必要字段是否存在。
7. 最近是否有 completed 数据。
8. `turn_id` 是否可用。
9. Cache 字段是否可用。
10. Dashboard Server 是否运行。
11. Overlay 所需 API 是否可用。

---

# 26. 数据库只读原则

数据库必须：

```text
readOnly: true
```

插件不得：

- INSERT
- UPDATE
- DELETE
- CREATE TABLE
- CREATE INDEX
- 修改 WAL
- 修改 SQLite PRAGMA 持久化配置

只允许 SELECT。

---

# 27. Schema 兼容策略

必须兼容旧版 ZCode。

如果：

```text
turn_id
```

不存在：

- Request 统计仍然工作。
- Turn 统计返回 null / unavailable。
- 不应导致整个插件失败。

如果：

```text
cache_read_input_tokens
```

不存在：

- Input 统计仍然工作。
- Cache 指标返回 null。
- 不得假设为 0。

如果某条记录：

```text
first_token_at
completed_at
```

无效：

```text
tokPerSec = null
```

不能产生：

```text
Infinity
NaN
```

---

# 28. `query_source` 审计

当前代码：

```text
query_source = 'main_turn'
```

优先过滤主对话。

必须在真机确认：

1. 正常问答。
2. 工具调用。
3. 多工具调用。
4. 多次模型继续生成。
5. 最终回答。

检查所有属于同一 Turn 的 Request 是否都具有：

```text
query_source = main_turn
```

如果有遗漏，需要调整过滤策略。

不能仅凭插件源码假设。

---

# 29. 真机 Phase 1：数据库审计

不要上传完整 `db.sqlite`。

执行：

```sql
PRAGMA table_info(model_usage);
```

执行：

```sql
SELECT sql
FROM sqlite_master
WHERE type = 'table'
  AND name = 'model_usage';
```

再执行脱敏后的：

```sql
SELECT
    session_id,
    turn_id,
    query_source,
    model_id,
    status,
    input_tokens,
    cache_read_input_tokens,
    output_tokens,
    reasoning_tokens,
    first_token_at,
    completed_at,
    time_to_first_token_ms
FROM model_usage
WHERE status = 'completed'
ORDER BY completed_at DESC
LIMIT 30;
```

如有额外 Cache 字段，全部记录。

---

# 30. Phase 1 验收

必须确认：

- 完整字段列表。
- `turn_id` 是否存在。
- `query_source` 的实际取值。
- Cache 字段。
- 时间字段单位。
- Token 字段是否可能 NULL。
- 一轮多 Request 的真实数据结构。
- 中断 Request 的 status。
- 是否存在后台/辅助 Request。

Phase 1 未通过，不进入代码重构。

---

# 31. Phase 2：建立 Core

新建：

```text
scripts/token-stat-core.mjs
```

实现：

```text
normalizeRequest()
validateRequest()
calculateRequestRate()

getLatestRequestStats()
getLatestTurnStats()
getWindowStats()
getSessionStats()
getHistory()
getAllStats()
```

先不改变 Dashboard / Hook。

---

# 32. Phase 2 测试

使用真实 DB + 固定查询结果验证：

### 单 Request

```text
output=1000
reasoning=100
generation=5s

=> 220 tok/s
```

### 多 Request Turn

```text
1000 / 3s
2000 / 5s
500 / 2s
```

应：

```text
generation = 3500
time = 10s
turn = 350 tok/s
```

### Cache

```text
input=20000
cache=15000
```

应：

```text
uncached=5000
hit=75%
```

---

# 33. Phase 3：切换 CLI

让：

```text
token-rate.mjs
```

全部通过 Core。

验证：

```text
--json
--turn
默认输出
```

输出结果与 Core 完全一致。

---

# 34. Phase 4：切换 Dashboard

修改：

```text
dashboard/server.mjs
```

使：

```text
/api/token-rate
```

调用：

```text
getAllStats()
```

前端不再自己计算。

验证：

- 页面正常刷新。
- history 点数正确。
- latest 正确。
- turn 正确。
- session 正确。
- cache 正确。

---

# 35. Phase 5：切换 Stop Hook

改：

```text
hooks/stop.mjs
```

调用 Core。

验证：

```text
单 Request Turn
多 Request Turn
工具调用 Turn
中断 Turn
```

特别验证：

```text
systemMessage
```

是否被当前 ZCode UI 正确显示。

---

# 36. Phase 6：删除 Prompt Injection

删除：

```text
TURN_STATS_INSTRUCTION
```

删除：

```text
additionalContext
```

删除模型执行统计命令的要求。

真机验证：

1. 发送普通 Prompt。
2. 发送需要工具的 Prompt。
3. 发送复杂多工具 Prompt。
4. 检查最终回答。
5. 确认没有 Token Monitor instruction。
6. 确认没有额外工具调用。
7. 确认 Stop Hook 仍工作。

---

# 37. Phase 7：删除 SessionStart Injection

确认：

```text
SessionStart
```

不再产生模型上下文。

插件说明移动到：

```text
README / command / doctor / dashboard
```

---

# 38. Phase 8：Overlay

保持原有功能。

增加：

```text
Cache Hit
```

如空间允许增加：

```text
TTFT
```

不得为了显示详细数据增加 Overlay 尺寸，除非用户明确要求。

---

# 39. Phase 9：MCP / Commands

全部切换到 Core。

验证：

```text
Dashboard == CLI == MCP == Stop Hook
```

同一时间点读取同一个 Session/Turn 时必须使用相同数据口径。

---

# 40. Phase 10：最终回归测试

## 场景 A：纯文本回答

确认：

- 无额外 Token Monitor Prompt。
- 无额外工具调用。
- Stop Hook 正常。
- Dashboard 正常。

## 场景 B：单工具

确认：

- 一个 Turn。
- 多个 Request 是否符合预期。
- Turn 聚合正确。

## 场景 C：多工具

确认：

- 所有主 Turn Request 都被正确聚合。
- 工具等待时间没有错误加入生成时间。

## 场景 D：中断

确认：

- 不产生错误统计。
- 不影响下一轮。
- 不出现 NaN / Infinity。

## 场景 E：新 Session

确认：

- 不会读取上一 Session。
- Dashboard follow 正确。
- Stop Hook 不串 Session。

## 场景 F：两个 ZCode Session

确认：

- Session A/B 不互相污染。
- 状态文件不会错误覆盖。

---

# 41. 零额外 Token 验收

这是最高优先级验收项。

最终源码中不得存在：

```text
TURN_STATS_INSTRUCTION
```

不得存在：

```text
UserPromptSubmit -> Token stats additionalContext
```

不得要求模型：

```text
node token-rate.mjs
```

不得要求模型：

```text
转发统计行
```

允许存在：

```text
Stop Hook -> systemMessage
```

因为它是 Hook 输出，不要求模型重新生成统计文本。

---

# 42. 统计一致性验收

同一 Request：

```text
CLI
Dashboard
MCP
```

必须一致。

同一 Turn：

```text
Stop Hook
CLI --turn
Dashboard latestTurn
MCP
```

必须一致。

同一 Session：

```text
Dashboard
CLI
MCP
```

必须一致。

---

# 43. 性能要求

Token Monitor 不得明显影响 ZCode。

要求：

- SQLite 只读。
- 查询使用明确 LIMIT。
- History 与 Window 分离。
- Dashboard API 不做无界查询。
- 不持续轮询 SQLite 的高频重计算，除非 Dashboard 已经需要每秒刷新。
- Overlay 继续使用 HTTP API，不直接访问 SQLite。
- Core 不保留长期数据库连接，除非经过性能验证后认为有必要。

---

# 44. 安全要求

插件只能读取：

```text
~/.zcode/cli/db/db.sqlite
```

默认只读。

不得：

- 上传数据库。
- 上传 Prompt。
- 上传模型响应。
- 上传 API Key。
- 上传环境变量。
- 上传文件。
- 增加未知外部网络请求。

Dashboard 默认：

```text
127.0.0.1:7423
```

不得无理由监听：

```text
0.0.0.0
```

---

# 45. Git 提交策略

建议每个 Phase 独立 Commit。

推荐：

```text
refactor: add unified token statistics core
fix: separate history and rate window
feat: add cache statistics
refactor: migrate CLI to token statistics core
refactor: migrate dashboard to token statistics core
refactor: migrate stop hook to token statistics core
refactor: remove token prompt injection
refactor: remove session start prompt injection
feat: expose cache metrics in overlay
refactor: migrate MCP and commands
test: add token statistics regression coverage
```

禁止把所有修改压成一个无法审查的大 Commit。

---

# 46. 回滚策略

每个 Phase 完成后：

1. 运行测试。
2. 真机验证。
3. Commit。
4. 记录结果。

任何 Phase 失败：

- 回滚该 Phase。
- 保持上一 Phase 可运行。
- 不继续叠加修改。

---

# 47. Agent 执行纪律

后续在真机中交给 Agent 执行时，必须遵守：

### 原则 1

先读代码，再改代码。

### 原则 2

先读取本机 Schema，再实现 Cache。

### 原则 3

不猜 ZCode 数据库字段。

### 原则 4

不上传完整用户数据库。

### 原则 5

不改变 ZCode 原始数据库。

### 原则 6

每阶段修改后立即测试。

### 原则 7

不要为了修一个显示问题重新启用 Prompt Injection。

### 原则 8

如果 `systemMessage` 在当前 ZCode 版本仍无法显示，优先使用 Dashboard / Overlay，而不是让模型参与转发。

---

# 48. Agent 第一阶段执行指令

Agent 启动后第一步不是修改代码。

执行：

```text
1. 检查当前 Git 工作区是否干净。
2. 创建独立工作分支。
3. 读取项目 README。
4. 读取：
   hooks/prompt-submit.mjs
   hooks/session-start.mjs
   hooks/stop.mjs
   scripts/token-rate.mjs
   dashboard/server.mjs
   dashboard/index.html
   dashboard/overlay.ps1
5. 检查 Node 版本。
6. 检查 node:sqlite。
7. 找到 ZCode model_usage 数据库。
8. 只读取数据库 Schema。
9. 输出 Schema 审计报告。
10. 在未得到完整 Schema 结论前，不修改 Token/Cache 计算代码。
```

---

# 49. Agent 第二阶段执行指令

完成 Phase 1 后：

```text
1. 设计 token-stat-core.mjs。
2. 明确 Request / Turn / Window / Session 数据口径。
3. 明确 Cache 字段映射。
4. 明确旧数据库兼容策略。
5. 添加单元测试/固定数据测试。
6. 再开始实现。
```

---

# 50. Agent 不允许擅自做的事情

除非用户明确批准：

- 不升级 Node。
- 不升级 ZCode。
- 不修改 ZCode 数据库。
- 不修改系统环境变量。
- 不安装全局 npm 包。
- 不修改用户 API Key。
- 不增加第三方服务器。
- 不增加遥测。
- 不上传用户数据。
- 不修改 Windows 系统设置以外的无关内容。
- 不删除现有功能。

---

# 51. 最终成功标准

当以下条件全部满足时，认为重构完成：

```text
[✓] 唯一 Token Statistics Core
[✓] Request 统计
[✓] Turn 统计
[✓] Session 统计
[✓] Window 统计
[✓] Input Tokens
[✓] Cache Read Tokens
[✓] Uncached Input
[✓] Cache Hit Rate
[✓] Weighted Token Rate
[✓] Dashboard 使用 Core
[✓] Stop Hook 使用 Core
[✓] CLI 使用 Core
[✓] MCP 使用 Core
[✓] Overlay 使用统一 API
[✓] UserPromptSubmit 不注入 Token Prompt
[✓] SessionStart 不注入 Token Prompt
[✓] 模型不执行 Token Monitor 命令
[✓] 不增加额外模型请求
[✓] SQLite 只读
[✓] 多 Request Turn 正确
[✓] 多 Session 不串数据
[✓] 中断场景安全
[✓] History / Window 口径正确
[✓] 无 NaN / Infinity
[✓] Windows Overlay 原功能保持
```

---

# 52. 后续可选增强

本次不作为第一阶段必做项。

未来可以增加：

1. Cost / Pricing。
2. 每 Turn 成本。
3. Session 成本。
4. 不同模型对比。
5. TTFT P50/P95/P99。
6. Token Rate P50/P95/P99。
7. Cache Hit Rate 曲线。
8. Input / Output / Reasoning 曲线。
9. Turn Request 数量统计。
10. Tool 等待时间。
11. End-to-End Turn Latency。
12. 模型切换检测。
13. 历史 Session 对比。
14. Dashboard 数据导出。

---

# 53. 最终架构原则

整个项目最终应该遵循：

```text
                    ZCode
                      |
                      v
                model_usage
                      |
                      v
            +-------------------+
            | Statistics Core   |
            +-------------------+
               |    |    |    |
               v    v    v    v
            Request Turn Session Cache
               |    |    |    |
               +----+----+----+
                      |
             +--------+--------+
             |        |        |
             v        v        v
        Dashboard   Stop     CLI/MCP
             |
             v
          Overlay
```

最重要的约束：

> **统计系统可以观察 ZCode，但不能为了统计而反向影响模型。**

---

# 54. 当前实施入口

Agent 真机实施时，从：

```text
Phase 1：model_usage Schema + 实际数据审计
```

开始。

**不得跳过 Phase 1 直接修改代码。**

Phase 1 完成后，再根据真实数据库 Schema 对本计划中的 Cache 字段和 Turn 统计进行最终确认。
