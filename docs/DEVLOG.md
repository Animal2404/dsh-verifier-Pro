# dsh-verifier-brain 开发全记录（DEVLOG）

> 项目：LLM-as-a-Verifier 大脑 × dsh-agent-teams 躯干
> 记录范围：从项目立项到当前的全部开发过程、遇到的问题、根因分析、解决方案、设计决策与实战教训
> 环境：Windows 11 / Python 3.12 / Node 24 / DSH（npm 安装版）/ 评分后端 opencode 端点 deepseek-v4-flash

---

## 目录

1. [项目立项与架构决策](#一项目立项与架构决策)
2. [Phase 1：首次构建（踩坑全记录）](#二phase-1首次构建踩坑全记录)
3. [Phase 2：第一轮实战反馈与修复](#三phase-2第一轮实战反馈与修复)
4. [Phase 3：工具合并与 Best-of-N 设计转向](#四phase-3工具合并与-best-of-n-设计转向)
5. [Phase 4：0.5 退化大修（最深的坑）](#五phase-405-退化大修最深的坑)
6. [Phase 5：马里奥 Best-of-N 实战（崩溃事故与证据先行）](#六phase-5马里奥-best-of-n-实战崩溃事故与证据先行)
7. [Phase 6：多模态证据链（视觉维度补测）](#七phase-6多模态证据链视觉维度补测)
8. [Ox Alpha 路由调查（搁置）](#八ox-alpha-路由调查搁置)
9. [架构问答沉淀：为什么不与 agent-teams 合并](#九架构问答沉淀为什么不与-agent-teams-合并)
10. [npm 发布基准参考（仅参考，未发布）](#十npm-发布基准参考仅参考未发布)
11. [最终资产清单](#十一最终资产清单)
12. [已知限制与下一步](#十二已知限制与下一步)

---

## 一、项目立项与架构决策

### 1.1 参考项目与各自定位

| 项目 | 定位 | 我们吸收了什么 |
|---|---|---|
| [llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier)（官方） | logprob 期望 reward 框架：select（PPT 锦标赛）/ compare / track / ProgressTracker | 算法本体直接用官方 PyPI 包 `llm-verifier 0.2.0`，不重复实现 |
| [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 多智能体协作（队长/成员/任务板） | "躯干"。集成方式：system prompt 策略段 + 服务调用，**不合并不 fork** |
| [uson1x/dsh-plugin-llm-verifier](https://github.com/uson1x/dsh-plugin-llm-verifier) | 纯 Node 评分器 + verify_rollout | `verify_rollout`（并行 N 尝试）的产品形态；但它不用 logprobs，细粒度价值打折，未采用其技术路线 |
| [lanbaolu/dsh-llm-verifier](https://github.com/lanbaolu/dsh-llm-verifier) | Python stdio 桥 + DSH 插件（同路线先驱） | 桥协议、参数白名单、images 降级等已验证设计；**独立重写**，修其三大短板 |

### 1.2 立项时的三个关键决策（用户拍板）

1. **全新独立项目**（不 fork lanbaolu）：吸收其桥协议与工具契约，架构按"大脑+躯干"重新设计
2. **v1 范围**：P0 工具层 + 团队集成一起上（差异化核心）
3. **命名**：`dsh-verifier-brain`

### 1.3 核心技术路线

```
DSH Agent
  ↓ verifier 工具（单一工具 × 8 action）
dsh-verifier-brain（Node/TS host 插件）
  ↓ JSON Lines over stdio（id 关联，线程池并发）
bridge/verifier_brain_bridge.py（ThreadPool × 4）
  ↓
llm-verifier 0.2.0（官方 PyPI 包）
  ↓ logprobs 后端
opencode 端点 deepseek-v4-flash（实测唯一可用）
```

**为什么必须走 Python 桥**：细粒度 reward 需要读取 score token 的完整 logprob 分布，DSH 的 `ctx.llm` 流式接口不暴露 logprobs——此路不通是立项前就确认的硬边界。

**为什么不能用会话主模型（ox-alpha）评分**：见[第八节](#八ox-alpha-路由调查搁置)。评分模型与对话模型本就不必是同一个。

---

## 二、Phase 1：首次构建（踩坑全记录）

### 2.1 环境底座

- Python 3.12.10 / Node v24.17.0 / Chrome 可用
- DSH 为 **npm 安装版**（`C:\Users\axia\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`），**没有源码 checkout**
- 项目 venv：`python -m venv .venv && .venv/Scripts/python -m pip install llm-verifier`（装到 0.2.0）

### 2.2 构建脚本五连坑（scripts/build.sh）

骨架由 `dev_scaffold_plugin` 生成，默认假设存在 DSH 源码 checkout（`packages/` + `vendor/` 布局），本机没有。逐个坑：

| # | 坑 | 现象 | 根因 | 解法 |
|---|---|---|---|---|
| 1 | 找不到 checkout | `ERROR: 未找到 DSH_CHECKOUT` | 骨架 build.sh 只会探测源码布局 | 重写 build.sh 支持**双布局**：源码 checkout（DSH_CHECKOUT）或 npm 安装版（自动探测 `node_modules/@deepseek-ai/dsh-tools`） |
| 2 | bash 不在 PATH | `bash: command not found` | Windows 裸环境 | 用 Git 自带的 `C:\Program Files\Git\bin\bash.exe` 执行 |
| 3 | **cordis junction 悬空** | `Cannot find module 'cordis'`，Test-Path 为 true 但内容不可读 | npm 版 dsh 里 cordis/cosmokit/schemastery 都是 **@deepseek-ai scoped 包**，脚本链接了不存在的顶层路径 | `link_pkg cordis "$NM/@deepseek-ai/cordis"` |
| 4 | **find 扑空静默杀脚本** | 构建在 "Linking" 后无输出退出（exit 1） | npm 版没有 `.pnpm` 目录，`find` 对不存在路径返回非零，`set -euo pipefail` 直接终止且无报错 | find 命令尾部加 `\|\| true` |
| 5 | tsc 不存在 | 无 typescript 可用 | 全机只有个别项目装过 | `DSH_TSC` 环境变量指向 `E:\DeepSeek\dsh-cost-crystal\node_modules\.bin\tsc.cmd`，或 npm 自举 |

**教训**：Windows 上调试 bash 构建脚本，`set -e` + 静默失败是最大敌人；`bash -x` 是救命稻草。

### 2.3 TypeScript 编译四连坑

| # | 坑 | 解法 |
|---|---|---|
| 1 | `TS5097: import path cannot end with '.ts'` | 相对导入从 `./bridge.ts` 改为 `./bridge.js`（NodeNext 下 tsc 解析回 .ts 源码，产物运行时正确） |
| 2 | `TS2322: Record<string, unknown>` 不满足工具返回契约 | execute 必须返回 `Record<string, JsonValue>`；加 `asToolResult()` 边界转换助手，`JsonValue` 从 `@deepseek-ai/dsh-tools` 导出 |
| 3 | `TS2345: 'dispose' not assignable to keyof Events` | cordis 没有 `ctx.on('dispose')`；改用 `ctx.effect(() => () => { bridge?.close() })` 的 disposer 形态（也更符合插件"资源全挂 effect"规范） |
| 4 | 删包装函数后括号不配平 | `timed(cached(...))` 改 `cached(...)` 时多留了一个右括号，TS1005 语法错——编辑工具精确替换后解决 |

### 2.4 首次注入与端到端

- `dev_inject_plugin` 注入成功（host ✓）
- 桥 ping 通过：`{"pong": true, "version": "0.2.0", "available": true, "workers": 4}`
- **并发验证**：一次管道喂两个请求（ping + usage），usage 先于慢请求返回——线程池乱序响应实证
- 首次真实 compare 撞上 DeepSeek 主站 402（余额不足）→ 触发后端排查（见下）

### 2.5 后端选型：四个端点逐一实测 logprobs

写了 `scripts/probe_logprobs.py`（带 `logprobs=True, top_logprobs=5` 的最小请求，检查响应里有无 token 级 logprobs）：

| 端点 | 模型 | 结果 |
|---|---|---|
| **opencode.ai/zen/go/v1** | deepseek-v4-flash | ✅ **返回 logprobs**（唯一通过） |
| api.b.ai/v1 | deepseek-v4-flash | ❌ 超时 |
| openrouter.ai | deepseek/deepseek-chat | ❌ 200 但无 logprobs |
| token.sensenova.cn | deepseek-v4-flash | ❌ 429 配额 |

**凭据自动映射**：`~/.dsh/.credentials.yaml` 里的 `OPENCODE_GO_API_KEY` 自动映射为 `OPENAI_API_KEY` + `OPENAI_BASE_URL=https://opencode.ai/zen/go/v1`，用户零配置。

### 2.6 首轮端到端成绩（修复前，注意区分度已经异常）

- progress：0.0 → 0.0 → 0.684（正确反映"改对代码"那步）✅
- select 三候选：index=0 正确，**但 scores 全 0.5** ⚠️（当时误判为"flash 粗粒度"，埋下了后来的大修伏笔）
- token 计量：缓存命中率 65% ✅

---

## 三、Phase 2：第一轮实战反馈与修复

用户实战（AgentTeams 三成员 LRU 缓存 Best-of-N）暴露四个问题（`dsh-verifier-brain-issues.md`）：

### 问题 1/2：同步与异步 select 都撞 300s 桥超时

- **现象**：3 个大候选同步 select 300s 超时；改异步 `task_start` 后轮询 10 分钟仍以同样的 300s 超时 error 结束
- **根因**：异步化只解决了"不阻塞会话"，但**单次桥调用的超时预算没有分离**——异步任务复用了同步的 300s
- **修复**：`PythonBridge.request(method, params, timeoutMs?)` 支持每次调用独立预算；新增 `taskTimeoutMs` 配置（默认 30min），仅异步任务使用；`bridgeTimeoutMs`（300s）只管同步工具
- **验证**：构建通过；后续实战异步 select 跑完无超时

### 问题 3：select 全 0.5 平分被当作有效排名

- **现象**：压缩载荷后 select 成功，但 scores=[0.5,0.5,0.5]，ranking 疑似按传入顺序平局决胜
- **修复（当时的第一层）**：flat 检测——全等分数时返回 `signal:"flat"` + 警告"排名无信号，必须 pairwise compare 复核"，render 同步显示 ⚠️
- **后续（第四节的真根因）**：0.5 不是"平局"，是评分管道整体退化，flat 检测只是兜底防线

### 问题 4：中文载荷 UTF-8 崩溃

- **现象**：`compare` 的 problem/criteria 含中文时报 `'utf-8' codec can't encode character '\udc87'`（lone surrogate）
- **根因**：Windows 下 Python stdin 默认用 locale 编码（cp936/GBK），UTF-8 字节流被误解码成 lone surrogate
- **修复**：双层防御——spawn 参数加 `-X utf8`；桥内 `sys.stdin/stdout/stderr.reconfigure(encoding="utf-8")`
- **验证**：中文 problem/criteria/注释全链路 E2E 回归通过

### 问题 5：异步任务只能盲轮询

- **修复**：`task_status` 新增 `wait_seconds` 长轮询（内部 2s 步进，cap 300s），完成即返回；工具描述建议 120s

### 同期产品决策：Best-of-N 从"评比"升级为"合并"

用户明确提出：**"应该是合并，而不仅仅是评比……各取所需，然后由一个独立代理或团队经理整合，但要防止过度工程化"**。

落地方针（刻意克制）：**不加新桥方法、不加编排工具，全部落在 prompt 策略层**：

```
排名（select/compare）→ 整合代理合并（全部候选+分数交给独立成员或队长另开一轮）
  → compare(合并版, 冠军) 门禁：合并版不低于冠军才采纳，否则回退并说明
```

设计边界：verifier 保持纯 reward 函数（不打文字评论、不写合并稿），整合是代理的活。

### 同期工具命名简化

用户反馈 `verifier_select` 太长。六个工具合并为**单一 `verifier` 工具 × 8 action**（select/compare/track/progress_start/update/close/task_start/task_status）。额外收益：工具目录 6 条 → 1 条，首轮 prefill 变省。

---

## 四、Phase 4：0.5 退化大修（最深的坑）

### 4.1 实战报告（用户 `Verifier插件问题记录.md`）

最致命的一条：**compare 候选一为完整议论文、候选二为纯乱码，返回 0.5/0.5**。连乱码都区分不了 = 打分管道整体退化，而非模型能力问题。

### 4.2 根因定位过程（读官方源码逐层剥开）

1. **0.5 的数值含义**：官方评分刻度是字母 A~T（20 档），均匀分布的期望恰好映射为 0.5 → 说明提取到的 score-token 分布是**均匀的/缺失的**
2. **读 `fine_grained_reward.py` 源码**，发现调用路由：
   - `create_openai_client` 只在 `base_url` 含 `api.deepseek.com` 时打 `_llm_verifier_deepseek=True` 标记
   - 无标记的 OpenAI 兼容端点走 `call_openai` → 其中**无条件**执行 `_score_tags_by_prefill`
   - prefill 依赖 vLLM/SGLang 专属的 `continue_final_message` + `structured_outputs` 参数
   - **源码注释原文**："a server without prefill support returns them tag-less (**scores fall back to 0.5**)"
3. **opencode 代理不支持 prefill** → prefill 抛异常 → 丢弃模型自己输出的评分标签 → extract 兜底 0.5

### 4.3 诊断脚本实证（scripts/diag_score_path.py）

用官方 `build_prompt` 构造真实评分提示，直接调 opencode 端点：

```
模型自己输出: <score_A> A </score_A> / <score_B> T </score_B>   ← 标签一直在！
响应携带: 198 个位置的 logprobs                                 ← 分布一直在！
跳过 prefill 直接提取: reward_a=1.0000 reward_b=0.0000          ← 区分度完美！
```

**结论：模型和端点都没问题，是官方包的调用路径选错了。**

### 4.4 修复方案（桥内打标记，不 patch 官方包）

```python
def _get_client():
    client = llm_verifier.fine_grained_reward.create_client()
    if not no_tag and not getattr(client, "_llm_verifier_deepseek", False) \
            and llm_verifier.fine_grained_reward._is_openai_client(client):
        client._llm_verifier_deepseek = True   # 走"读模型自身标签"路径
    return client
```

- 通过官方 API 的 `client=` 参数注入，**零 monkey-patch、零 site-packages 修改**
- 附带收益：新路径在 logprobs 缺失时**抛错而非静默 0.5**（官方 DeepSeek 路径的硬校验）
- `DEEPSEEK_EFFORT=off` 设为桥内默认（实测 opencode 接受 `{"thinking":{"type":"disabled"}}`，拒绝更复杂的 thinking extra_body）
- 逃生口：`VERIFIER_BRAIN_NO_TAG=1` 恢复官方默认行为

### 4.5 修复后回归（对照用户复现要点）

| 回归项 | 修复前 | 修复后 |
|---|---|---|
| 好文 vs 乱码 compare | 0.5/0.5 ❌ | **1.0/0.0** ✅ |
| A vs C（111.txt 真文） | 3 次全平 ❌ | **1.0/0.79** ✅ 方向正确 |
| A/B/C select | 全 0.5 ❌ | **0.551/0.550/0.399** ✅（A=B 内容相同给同分，C 显著低） |
| track 梯度 | 常数 ❌ | 同路径随修生效 ✅ |

111.txt 实战：三篇文章中 A、B 内容完全相同——verifier 给出 0.5512/0.5502（几乎同分）+ C 0.3985。**同文同分、异文异分，教科书级表现。**

---

## 五、Phase 5：马里奥 Best-of-N 实战（崩溃事故与证据先行）

### 5.1 提示词设计的自我纠正（用户两次纠偏）

**第一次纠偏——"合并而非仅评比"**：初版流程只排名。修正为三步闭环（排名→合并→门禁）。

**第二次纠偏——"不是让子代理专门优化哪个"**：初版提示词给三个成员分配了单一侧重点（手感/关卡/视觉），产出的是三个"偏科残缺版"。用户指出这违背 Best-of-N 本意。重读参考项目确认：

- 官方 Terminal-Bench 自验证：同一任务 **5 条完整轨迹**
- uson1x verify_rollout："ask for something **once**, several **independent agent attempts**"
- lanbaolu ROADMAP："给定 problem → **并行生成 N 个候选**"
- agent-teams 集成点："**同一**关键任务派给多个成员"

**铁律**：Best-of-N = 同一任务 × N 次独立完整尝试；多样性来自独立实现的随机性，绝不来自人为分工（分工切面是任务分解模式，残缺候选破坏锦标赛的可交换性前提）。此条已写入插件 system prompt 策略永久生效。

### 5.2 B 版崩溃事故（CDP 实证诊断）

**用户报告**：mario-b.html 开始游戏后人物图层不显示，死亡后才突然出现。

**排查过程（静态分析三次扑空后转向实证）**：

1. 静态看 `drawPlayer`：正常（无敌闪烁逻辑 120 帧，只该闪 2 秒）
2. 静态看渲染结构/主循环/死亡分支：无异常
3. **转向 CDP 实证**：Chrome headless + `--remote-debugging-port=9222`，Node 24 内置 WebSocket 直连 CDP，页面内 `startGame()` 后手动驱动 `update()`

**当场抓获**：

```
TypeError: Cannot read properties of undefined (reading 'x')
    at update (mario-b.html:306:25)      ← level.flag.x：level.flag 是 undefined
```

**根因**：

```js
function makeLevel(cfg){
  ...
  return { grid: g.map(r=>r.join("")), width: w, name: cfg.name };
  //     ↑ flag 和 start 字段被丢了！
}
```

`level.flag === undefined` → playing 状态每帧抛 TypeError → 异常中断主循环 → **draw() 永远不执行** → 画面冻结。死亡/过关状态走提前 return 分支不崩，才能画出一帧——这就是"死亡后才显示"的表象。

**修复**：一行——`return { grid, width, name, flag: cfg.flag, start: cfg.start }`。

**传染面检查**：只有 B 中招（A 用 `flagX` 字段、C 有 `level.flag &&` 防护、final 用 A 的方案）。

**冒烟回归**（`scripts/cdp_mario_smoke.cjs`）：四文件各跑 300 帧 update，全部零报错，B 版截图确认玩家/敌人/金币/HUD 正常渲染。

### 5.3 更重要的教训：为什么 Verifier 没拦住它？

**一个每帧崩溃的游戏得了 0.5066 分，还成了合并素材。** 因为 verifier 评的是成员**自报的功能摘要**——摘要里 B 版"声称"功能完整，评分照单全收。官方提示词的戒律："Trust observed output — NOT the agent's narration"，我们喂的恰恰是 narration。

**对策（已固化进插件策略层）**：

> Trust observed output, NOT the agent's narration: candidate summaries must be backed by verifiable evidence (smoke-test results, runtime-error counts, hard facts extracted from the actual artifact)... a candidate that crashes at runtime must be rejected regardless of its claims.

配套沉淀 `scripts/cdp_mario_smoke.cjs` 通用无头冒烟工具（Chrome CDP，适用于任何 HTML/JS 产物）。

### 5.4 升级后的 Best-of-N 完整流程

```
N 个成员各自完整实现（同一任务，禁止分工切面）
  → 每个产物无头冒烟测试（崩溃者直接出局，分数记 0）
  → 幸存者的"实测证据 + 功能摘要"交给 verifier select/compare
  → 整合代理合并（从冒烟通过的完整版中取长补短）
  → 合并版也要过冒烟测试 → verifier compare 门禁
```

---

## 六、Phase 6：多模态证据链（视觉维度补测）

### 6.1 用户质疑："实际游玩觉得 B 和 C 的画风都比 A 好，为什么 A 获胜？"

三层原因拆解：

1. **证据层**：verifier 评的是文字摘要，画风在摘要里不可见——它评的是"谁的摘要更像合格的工程报告"
2. **标准层**：当时的评分标准（可玩性/功能/手感/代码）**没有视觉表现这一项**——它忠实地评了，但没评用户在意的
3. **信号层**：A=0.5349 vs B=0.5066，分差 0.028 在 flash 单次评估的噪声区间，flat 检测只抓"完全相等"，对"差异小于噪声"没有防线

### 6.2 补测实验（多模态证据链首次跑通）

链路：**无头截图 → 多模态模型看图写结构化视觉描述 → verifier 按"视觉表现"标准评分**

```
A（经典FC复刻）：蓝天白云绿丘橙砖，还原准确但场景空旷，截图 15KB（信息量最低）
B（赛博霓虹）：夜空星空+霓虹天际线+透视网格+发光粒子，细节密度最高，62KB
C（暖色卡通）：阳光草地渐变+Q版造型+圆角高光，精致可爱，43KB
```

评分结果（真实调用）：

| 对比 | reward_A | reward_B/C |
|---|---|---|
| A vs B | 0.395 | **0.947** |
| A vs C | 0.526 | **0.947** |

**与用户肉眼判断完全一致，且区分度极大。** 同一个 verifier、同一个模型，喂料正确立刻给出正确判断——证明**之前是流程缺陷，不是算法缺陷**。

### 6.3 链路里的模型分工（ox-alpha 的正确位置）

```
无头截图 → ox-alpha（支持图像输入）当"眼睛"：看图写结构化描述
        → deepseek-v4-flash（logprobs）当"评分器"：按标准出 reward
```

ox-alpha 不能当评分器（无 logprobs），但可以当观察者——两个模型各干擅长的事。此链路已验证有效，**自动化**列入下一步。

---

## 七、Ox Alpha 路由调查（搁置）

用户要求"只使用 Ox Alpha 模型"评分。调查结论（全部实测）：

1. ox-alpha 只存在于 openrouter（`stealth/ox-alpha`），opencode 端点没有 → 之前传 `model:"ox-alpha"` 报 401 是必然
2. openrouter 的 ox-alpha：非流式调用一律 502；**流式正常**（本会话即流式）
3. 致命点：流式 + `logprobs=True` → 又是 502。**Stealth 上游不支持 logprobs**
4. 结论：与 LLM-as-a-Verifier 的核心机制（logprob 期望）根本不兼容，只能降级为普通 LLM-as-a-Judge，失去框架立身之本

**用户决策**："Ox Alpha 如果不行就先别管它" → 搁置。评分后端维持 deepseek-v4-flash。

---

## 八、架构问答沉淀：为什么不与 agent-teams 合并

用户问"为什么不直接合并进 dsh-agent-teams"。六条理由：

1. **场景超集**：verifier 大部分使用场景（两方案对比、文章优选、进度感知）不需要团队；合并会强制加载整套多智能体机器
2. **依赖方向**：agent-teams 是 NanmiCoder 的第三方插件，合并 = fork = 上游每次更新都要手工 rebase
3. **变更节奏差两个量级**：verifier 一天迭代四轮 vs agent-teams 稳定版
4. **服务缝已存在**：`ctx.verifierBrain` 服务 + prompt 策略段就是 cordis 体系的正确"合并"形态——神经已接好，不必缝合身体
5. **可替换性**：换大脑（未来 TS 原生版）躯干不动；换躯干（更好的团队框架）大脑不动
6. **故障隔离**：桥/venv/评分的故障不拖累团队调度器；fiber 各自独立热重载

---

## 九、npm 发布基准参考（仅参考，未发布）

用户提供了 lanbaolu 包的 socket.dev 页面作参考（**明确：仅参考，未要求发布**）。registry 实测数据：

| 维度 | @lanbaolu/dsh-llm-verifier |
|---|---|
| 版本 | 0.0.1 → 0.1.0 → 0.1.1（一天内发完，小步快发） |
| 周下载 | **433 次**（生态有真实需求） |
| 包体 | 248KB / 33 文件（含 Web UI 面板；不带 venv） |

对照后本项目做了无害整备（保留，发布与否待定）：补 LICENSE（BSD-3-Clause）、package.json 发布化元数据（去 private、keywords/engines/author）、`npm pack --dry-run` 预演通过（32.1KB / 30 文件）。**未发布、未配置 npm 账号。**

---

## 十、最终资产清单

### 代码资产（E:\DeepSeek\dsh-verifier-brain）

```
├── bridge/verifier_brain_bridge.py   # 并发桥（线程池/tracker锁/打标client/UTF-8/排水）
├── src/
│   ├── index.ts        # 入口：配置/venv探测/惰性桥/服务注册/prompt注入
│   ├── tools.ts        # 单一 verifier 工具 × 8 action + 任务管理器 + flat检测 + 缓存
│   ├── bridge.ts       # CDP 桥管理器（崩溃自重启/独立超时/自动重连）
│   ├── credentials.ts  # 凭据复用（credentials.yaml + 代理别名映射）
│   ├── persist.ts      # JSONL 持久化（history/tasks）
│   ├── prompt.ts       # system prompt 策略（四条铁律）
│   ├── service.ts      # ctx.verifierBrain 服务缝
│   └── types.ts
├── scripts/
│   ├── build.sh              # 双布局构建（npm版/源码版 dsh）
│   ├── probe_logprobs.py     # 端点 logprobs 探针
│   ├── diag_score_path.py    # 评分链路解剖
│   ├── verify_fix.py         # 0.5 修复回归
│   ├── e2e_bridge_test.py    # 桥全流程测试
│   ├── cdp_mario_smoke.cjs   # 通用无头冒烟测试（Chrome CDP）
│   └── cdp_mario_diag.cjs    # CDP 单文件诊断
├── docs/（PLAN / ROADMAP / DEVLOG 本文件）
├── cordis.patch.yml    # 挂载配置（verifierModel/超时预算/worker数）
└── .venv/              # llm-verifier 0.2.0 运行时（68MB，gitignore）
```

### 运行时状态

- 装配：web profile bundle + patch 双路径，host 内 fiber active
- 状态数据：`~/.dsh/verifier-brain/{history,tasks}.jsonl`
- 配置：`verifierModel: deepseek-v4-flash` / 同步 300s / 异步 30min / 4 workers

### 策略层四条铁律（system prompt，全部经实战教训写入）

1. **合并而非仅排名**：排名→整合代理合并→compare 门禁
2. **完整尝试**：同一任务 × N 独立完整实现，禁止分工切面
3. **证据先行**：冒烟测试结果喂评分，崩溃候选直接否决，不采信自述
4. **成本纪律**：n_evaluations=1、异步+压缩载荷、wait_seconds 长轮询

---

## 十一、已知限制与下一步

### 已知限制

1. 多模态直评未自动化（当前人工串联：截图→ox-alpha 描述→flash 评分）
2. flash 单次评估区分度有限，接近质量候选需 n_evaluations>1 或多标准
3. 分差噪声防线缺失：分差 <0.05 仍会被当作有效排名（马里奥案例教训，待加自动复核）
4. Web 设置面板、/bestofn 一键命令、进度传感器自动挂接未做
5. ox-alpha 不可用作评分后端（无 logprobs，已搁置）
6. 异步任务桥内存态，桥重启靠 tasks.jsonl 兜底

### 下一步优先级

1. **多模态证据链自动化**（已验证有效，价值最高）：冒烟截图 → ox-alpha 写描述 → verifier 评分，串进 Best-of-N 流程
2. **/bestofn 一键命令**：固化"N 完整实现→冒烟→评分→合并→门禁"整条链
3. **噪声防线**：分差 <0.05 自动升级 compare 复核
4. Web UI 设置面板 + 分数曲线（P2）

---

## 十三、Phase 7：M1 自适应升级验收（ITERATION_PLAN §3 十用例回归）

> 2026-08-21 · 对应 ITERATION_PLAN（M1 已完成 / M2 验收回归）

### 7.1 验收脚本

`scripts/acceptance_ts.mjs` —— 直接 import `lib/` 的 TypeScript 层
（`PythonBridge` + `VerifierStore` + `createEscalationRunner` + `createVerifierTaskManager`），
走完整升级/缓存/flat/异步路径，而不是只打桥协议。

| # | 用例 | 结果 | 备注 |
|---|---|---|---|
| 1 | 好文 vs 乱码 compare | ✅ | margin 巨大不升级，1.0/0.0 |
| 2 | 接近分差自动升级 K=3 | ✅ | k_used>=2，含 margin_before |
| 3 | 完全相同候选 flat 检测 | ✅（修复后） | **初次回归抓出缺陷**，见 7.2 |
| 4 | 中文载荷 + 升级 UTF-8 | ✅ | 中文 problem/criteria 无回归 |
| 5 | autoEscalate:false 回退 | ✅ | 与 v0.1.0 一致，不升级 |
| 6 | 异步任务 task_start/status | ✅ | statusWait 长轮询 done |
| 7 | token 计量 usage | ✅ | 桥 usage 方法可用 |
| 8 | select N=5 接近分差升级 | ✅ | 前二名落噪声带升级；flat 候选组正确标 flat |
| 9 | 升级结果缓存命中 | ✅ | 二次调用 cached:true |
| 10 | compare 胜者翻转 unstable | ✅ | 返回 raw reps 或稳定升级 |

**结果：10/10 通过。**

### 7.2 回归抓出的真实缺陷：flat 检测在 M1 重构中丢失

- **现象**：完全相同候选（`['4','4','4']`）select 返回 scores=[0.5,0.5,0.5]，
  但**没有 `signal:'flat'`**——v0.1.0 的"全等分数 → 提示排名无信号"防线消失。
- **根因**：M1 重写 `runSelect`/`runCompare` 时，只在 `renderResult` 保留了 flat
  的渲染分支（`value.signal === 'flat'`），却没有在升级判定处**写入**该信号。
- **修复**（`src/tools.ts`）：
  - `runCompare`：`margin ≤ FLAT_EPSILON(0.03)` 时注入 `signal:'flat'` + warning
  - `runSelect`：`topGap ≤ 0.03` 时注入 `signal:'flat'` + warning
  - `renderResult`：flat 分支兼容 compare 形态（reward_a/reward_b）
- **验证**：#3 复跑通过；全量 10/10 通过。
- **教训**：重构升级逻辑时"信号注入"与"信号渲染"必须成对迁移——渲染分支还在，
  注入分支却丢了，静默失去防线。验收回归正是为此而设。

### 7.3 M2 结论

ITERATION_PLAN 的 M1（自适应 K 核心）与 M2（十用例验收回归）**均已完成**。
按计划（§7："M1+M2 完成即可发一个版本 0.2.0"），当前达到 **v0.2.0 发布门槛**。

