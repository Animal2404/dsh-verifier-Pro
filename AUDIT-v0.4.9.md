# v0.4.9 三方交叉审计报告（Best-of-N 合并版）

> 审计对象：`E:\DeepSeek\dsh-verifier-brain` @ da7a7d8（v0.4.9，干净树）
> 方法：三名独立审计员（auditor-1/2/3）各自完整读码审计 + 队长证据包交叉复核；本文件为三方合并后的**唯一权威清单**
> 原始报告：`E:\tmp\audit-a1.md`(19.7KB) / `audit-a2.md`(rev2) / `audit-a3.md`(rev2)

---

## 〇、队长证据包终审（8 项嫌疑的最终裁定）

| # | 队长原判 | 终审 | 关键证据 |
|---|---------|------|----------|
| S1 | 去重虚报已提交 | **事实成立·载体改判**：代码全历史不存在（git -S indexMap=∅）；但 CHANGELOG/README 从未声称——虚报只在本轮会话汇报与待办；docs 内是未勾选 TODO | `git show 2dd86b8:CHANGELOG.md` 无此项 |
| S2 | 异步预算 30min→5min 回归 | **不成立**：runner deps 用 taskTimeoutMs(index.ts:166)；tools.ts:479 是死代码（track 不进 runner）；历史回归已在范围前 521f36a 修复。遗留地雷：未来直接 runner('track') 会静默 300s+绕闸 | 三方一致 + git show 核对 |
| S3 | AbortSignal 监听器泄漏 | **成立且加宽**：成功 resolve/超时/failAllPending 三条路径都不移除 | bridge.ts:145 vs :159/:167 |
| S4 | 升级绕过 clamp | **成立且加重**：reps 原始入列(:276-278)、composite 用未裁剪 s3 平均(:431-435)、且 **composite 全新构建整体丢弃 k1.anomaly/warning**(:303-312/:437-447) | 三方一致 |
| S5 | stateDir 运行时异常 | **排除**：persist.ts:18 兜底 ~/.dsh/verifier-brain；实证磁盘存在活跃 jsonl。降级为 schema 洁癖（z.string() 无 default 与 TS optional 不一致） | persist.ts:17-26 |
| S6 | setup --fix 假成功 | **成立**：writePatchConfig 的 vmReplaced/bbReplaced 计算后弃用，written:true 无条件返回 | setup.mjs:607-629/996-1006 |
| S7 | probe 真花钱+误分类 | **成立·方向修正**：每 plugin apply 一次真实计费 compare；错误分类为子串嗅探——含"logprob"→false，其余(401/402/网络)一律 **True（绿灯放行）**，坏后端被报健康 | py:360-377 |
| S8 | pivots/n_evaluations 无上限 | **成立·前提部分修正**：n_evaluations cap=20 从未存在；pivots 在包内被 min(k,n) 钳制，真爆炸向量是 n_evaluations（乘进每对×每标准） | tools.ts:675-679 / py:221-222 |

---

## 一、统一问题清单（三报告去重后）

### 🔴 P1 —— v0.5.0 必修

| ID | 问题 | 位置 | 修复要点 |
|----|------|------|----------|
| **F1** | **升级评分绕过 clamp01/anomaly，composite 丢弃 k1 异常标记**；且 clamp 警告在常见路径端到端不可见（renderResult 只在 flat/degraded 分支打印 warning；面板 ok 态不渲染 hostDetail）——P0-5 防线形同虚设 | tools.ts:276-278/298/302-305/410-411/431-439/606-616；VerifierPanel.tsx:127-150 | rep 循环内逐个 clamp 并累计 anomaly；composite 前钳 s3/averaged；anomaly 提升到结果顶层；renderResult flags 行追加 warning/anomaly；面板新增 anomaly stateKey |
| **F2** | **SECURITY.md:23 将未实现的注入防护写成"已加固"事实**（随包分发的安全文档夸大缓解；同文件风险节又自认未做） | SECURITY.md:23 | 改口为"规划中/未实现"，或先实现再写；同轮把 sanitizeForVerifier（截断+黑名单）真正接入 runSelect/runCompare/parseCriteria 调用点 |
| **F3** | **NaN/Infinity 打穿 stdio 协议**：py json.dumps 默认输出字面 `NaN` → TS JSON.parse 抛错 → 该请求静默挂到全额预算超时（数分钟假死而非报错） | py:76-90/409-411；bridge.ts:190-195 | `_jsonable` 对 nan/inf 返回 None + `json.dumps(..., allow_nan=False)` 兜底断言 |
| **F4** | **images 双洞**：compare 缓存键漏 images（30min TTL 内串味）；select 收下 images 却在 mkParams 丢弃（多模态用户无感知拿到纯文本评分）。lanbaolu 前辈两者都进了键 | tools.ts:206/320-329 vs :203 | 两处键补 images(+seed)；mkParams 补透传 |
| **F5** | **AbortSignal 监听器泄漏**（成功/超时/failAllPending 三路径不移除）；配套：TS 计时器放弃请求但 Python 侧继续烧 token（协议无 cancel），uson1x 用 `AbortSignal.any([signal, timeout])` 真取消可借鉴 | bridge.ts:145/159/167 | handleLine resolve 时移除；中期在协议层加 cancel 方法 |
| **F6** | **并发闸门与加固被绕过**：scoringGate 未传入 task-manager/bestofn 的 runner deps（index.ts:166 无 scoringGate）；服务化接口 `ctx.verifierBrain.*` 直连 bridge.request——无限并发、无缓存、无 clamp、无升级 | index.ts:166；service.ts:24-54 | runner deps 注入 gate；service 层改走同一 runner |

### 🟠 P2 —— v0.5.x

| ID | 问题 | 位置 |
|----|------|------|
| F7 | probe 重设计：能力测试改为 1-token 带 logprobs 探针（或复用最近真实评分）；错误按类型族分类（auth/quota/capability），杜绝绿灯放行 | py:360-377 |
| F8 | setup --fix 三连：假成功（替换行缺失应插入或明确报错）、非原子写入（tmp+rename）、每次运行无条件新增 .bak | setup.mjs:596-629 |
| F9 | bestofn Windows 超时标记失效（signal=null → 无 124 无标注）；用 killer 触发布尔标志替代 signal 判定（smoke.mjs:74-87 有仓内正确范本） | bestofn.ts:81-83 |
| F10 | 同名候选 smoke.json 互相覆写 → 淘汰可能杀错人（文件名加内容短哈希） | evidence/smoke 输出名 |
| F11 | tasks.jsonl 每 2s 轮询全量重扫 + 无轮转 + 重启后 running 永久悬挂；records Map 不修剪 | persist.ts:50-60/tools.ts:497/538-544 |
| F12 | select 每调用临时缓存文件从不删除（%TEMP% 已见 4 个陈旧文件）；finally unlink | tools.ts:337-340 |
| F13 | runCompare 升级首 rep 失败连成功的 k1 一起扔（select 有优雅降级，compare 没有）——不一致 | tools.ts:280 |
| F14 | 死配置复活：maxCostPerVerification 接官方 token_usage() 钩子实现真实预算拦截 | index.ts/py usage |
| F15 | n_evaluations/max_workers 边界钳制（≤20 / ≤桥 worker 数），结果附注说明被钳制 | tools.ts 工具边界 |
| F16 | /bestofn `--summary name=text with spaces` 解析被打爆 → 可能误触团队 fan-out；-n 无上限（500 也照派） | bestofn.ts:113/132-142 |
| F17 | build.sh 补跑 check_client.mjs（changelog 已宣传该管线）；client/index.tsx 过期注释更新 | build.sh:149-151 |

### 🟢 P3 —— 排期池
stateDir 等 5 个无 default 字符串补 schema default · 命名漂移（repo/pkg/dir/brain 四名）· engines.node 偏严 · mojibake 注释清理（index.ts/persist.ts）· letterAt≥8 数字混排 · 平局只亮 A 的展示 · peerDeps 补 dsh-client-ui-tool(type-only) · Semaphore.acquire 死 API+release 双击护栏 · LRU.has 刷新 recency 加注释 · promptSection 双段常驻 ~4.5KB 权重（bestofn 协议段与激活消息重复，考虑改 skill 按需加载——agent-teams 模式）· 重启后异步任务 running 永久悬挂的恢复垫片

### ⚪ 参考仓采纳清单
uson1x：真取消(AbortSignal.any) · 单点 normalizeScore · 边界 assertPositiveInteger · mapLimit ｜ lanbaolu：缓存键含 images+seed ｜ agent-teams：atomicWriteText 原子写 · per-key 锁 · 可重试租约 · skill 按需文档

---

## 二、被驳倒的队长误判（存档防复发）
S2 异步预算回归（双重误读：deps 归属 + track 路由）、probe 方向反转、CHANGELOG 虚报位置、stateDir 运行时异常。**教训：pickaxe 先行 + 让审计员读 index.ts 构造点，能避免两处误判。**

## 三、正面确认
- smoke.mjs 主淘汰链路健壮（probe-skip 显式标注、导航不丢错误采集）
- Semaphore/LRU 无实质缺陷（abort/release 竞态有顺序保证）；11/11 测试过
- client 面板 XSS 安全；徽章优先级正确；算法层与官方包语义一致（exact-flat 护栏精准命中 on_error=tie）
- 架构与诚实文档文化获好评："no P0 remains"；SECURITY.md 修正后即为扎实 v0.5.0

---

## 四、修复顺序建议（v0.5.0 冲刺序）

```
① F2 SECURITY.md 改口（10min，止血诚信）
② F1 clamp 全链路 + anomaly 透传（核心不变量）
③ F3 NaN 协议加固（防假死）
④ F4 images 双洞 + 缓存键
⑤ F5 监听器泄漏 + F6 闸门/服务层收口
⑥ F7-F17 按 P2 序批量
⑦ 全程 npm run verify + CDP 截图回归
```

---

*合并：队长（会话模型）· 基于 auditor-1/2/3 三份独立报告 · 2026-08-23*
*原始报告归档：E:\tmp\audit-a{1,2,3}.md（蓝屏存活验证通过 ✅）*