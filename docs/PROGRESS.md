# PROGRESS — dsh-verifier-Pro

> 事实记录：每个版本实际完成了什么、验证状态如何。不做承诺（承诺看 PLAN.md）。

## v0.4.3（当前迭代，未发版）

### 已完成（全部通过 typecheck + 离线测试）

| 类别 | 事项 | 验证 |
|------|------|------|
| **Client 工程化** | `src/client/index.tsx`（VerifierPanel + SettingsPanel）、`tsconfig.client.json`、`tsdown.config.ts`、patch.yml client 注入、build.sh 集成 tsdown + dsh-commands 链接 | `bash scripts/build.sh` 全绿；client bundle `lib/client/index.js` ≈9.8KB |
| **并发加固** | 零依赖 `Semaphore`（限流桥评分调用）+ `LRUCache`（500 条/30min TTL）替换无界 Map | `tests/concurrency.test.mjs` 11 用例全过 |
| **子进程生命周期** | evidence_chain spawn 加 10min 硬超时（SIGTERM→5s 后 SIGKILL），退出码 124 标记超时 | typecheck 通过；逻辑评审 |
| **分数裁剪** | compare/select 返回值 clamp 到 [0,1]，越界时打 `anomaly` 标记并附原始值警告 | typecheck 通过 |
| **AbortSignal** | bridge.request / runSelect / runCompare / track / progress_* / usage 全链路透传 | 前序会话完成 |
| **安装自动化** | setup.mjs --fix 自动写 cordis.patch.yml 两行（时间戳备份），0 手动项 | 实测 --fix 输出 4/4 就绪 |

### 测试现状

- Offline 单测：**11 pass / 0 fail**（`npm test`）
- Composition/E2E/GUI 层：**未建**（见 PLAN.md）

## v0.4.2（已发布）

- Python 桥并发 worker、状态落盘、Windows 一等公民、桥崩溃自重启
- 自适应 K 升级（margin 落噪声带自动 K=3）、exact-flat/degraded 护栏
- probe_logprobs / scan_logprob_models 脚本；setup.mjs 三合一合并版
- 安全事件处置：git filter-repo 清除历史泄露 key + 强推 + key 轮换

## 已知事故记录

| 日期 | 事故 | 处置 |
|------|------|------|
| 2026-08-22 | opencode DFLASH 投机解码导致 deepseek-v4-flash logprob 全灭（400） | 切 deepseek-v4-pro；README 对照表标注 |
| 2026-08-22 | git 历史泄露 sk- 开头 API key | filter-repo 重写历史、强推、轮换 key |
