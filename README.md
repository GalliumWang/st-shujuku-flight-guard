# ACU Flight Guard — 数据库经典模式·大总结删楼守护

一个专为 SillyTavern 数据库插件 [**龙血玄黄·数据库 (shujuku)**](https://github.com/AlbusKen/shujuku) 设计的无侵入式轻量第三方伴生扩展，用于自动检测并修复经典表格模式下因删楼/回退操作造成的「纪要表失踪」问题。

---

## 问题背景

在 `shujuku` 的**经典表格模式**中：

- 每当填表 AI 写入一条新的 `<大总结>` 时，系统会把本轮归纳过的旧纪要行 ID 记录在会话顶层的 `TavernDB_ACU_ScopedConfig.flightModeByIsolationKey[tag].hiddenRowIds` 中，使其在发往主 AI / 填表 AI 与世界书导出时隐藏。
- 然而该 `hiddenRowIds` 存储在全局 `chatMetadata` 与 `chat[0]` 中，与具体 AI 楼层上的数据库增量操作生命周期不同：如果你**删除或回退了恰好触发 `<大总结>` 的那几层楼**，新增的 `<大总结>` 会随之回退消失，但 `hiddenRowIds` 依然残留。
- 不及时处理时会出现：
  1. 主 AI 与填表 AI 既看不到 `<大总结>`，又看不到被误留在隐藏名单里的旧纪要（前序剧情断代）；
  2. 填表 AI 看到一张 0 行的空纪要表，重新从 `AM0001` 编号插入，导致 SQLite 模式下 `code_index UNIQUE` 唯一键冲突报错或编号混乱。

---

## 功能特性

- **零侵入 & 零升级冲突**：不修改 `shujuku` 一行源码，直接通过公开的 `window.AutoCardUpdaterAPI` 与宿主元数据接口协作，`shujuku` 后续随时正常升级。
- **零额外 Token 消耗**：纯前端/本地状态对齐，不触发任何额外 LLM API 请求。
- **全阶段精确还原**：
  - **退回 0 条大总结**（删掉了第 1 次触发大总结的楼层）：自动清空残留 `hiddenRowIds`，全部旧纪要立刻恢复可见。
  - **多阶段大总结部分回退**（如第 2 次大总结楼层被删，退回只剩第 1 次大总结）：通过随大总结生长记录的阶段快照账本 `TavernDB_FlightGuard_Ledger`，只解除第 2 阶段纪要的隐藏，第 1 阶段已归纳纪要继续保持隐藏。
  - **存量旧对话兜底**：即使安装本扩展前已经生成了多期大总结，在发生回退时也能自动通过 `AutoCardUpdaterAPI.exportTableSnapshotsAtMessages()` 回溯最近一条幸存大总结前的快照，反推出正确的隐藏行集合。
- **自动重刷世界书**：修复后立即调用 `syncWorldbookEntries()` 将恢复可见的纪要重新注入世界书条目。
- **可视化状态面板**：可在酒馆扩展设置面板实时查看连接状态、经典模式开关、大总结行数、隐藏纪要数与账本快照数，也支持手动一键检查对齐。

---

## 安装方法（SillyTavern 一键安装）

1. 打开 SillyTavern 右上角 **扩展（Extensions）** 面板 → **Install Extension（安装扩展）**。
2. 粘贴本仓库地址：
   ```text
   https://github.com/GalliumWang/st-shujuku-flight-guard
   ```
3. 点击确认安装并刷新页面即可自动启用（加载优先级 `250`，默认在 `shujuku` 的 `200` 之后挂载，如加载顺序不同也会自动异步轮询等待 `AutoCardUpdaterAPI` 就绪）。

---

## 本地测试

```bash
npm test
```

## License

MIT
