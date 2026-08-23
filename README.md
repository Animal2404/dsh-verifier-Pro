# dsh-verifier-Pro

<div align="center">

**简体中文** | [English](./README.en.md)

</div>

[LLM-as-a-Verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) 大脑插件，为
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 而生——尤其是
[dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) 多智能体团队。

> 🧠 **大脑：LLM-as-a-Verifier · 躯干：dsh-agent-teams。**
> 本插件把官方框架的细粒度验证能力（基于 score-token logprob 分布的期望 reward，
> 而非普通 LLM-as-a-Judge 的单点打分）做成 DSH agent 工具，并通过 system prompt
> 策略注入，让它成为多智能体团队的内置评审器官。

```
DSH Agent
  ↓ verifier 工具（单一工具 × 9 action：select/compare/track/progress_*/task_*/usage）
dsh-verifier-Pro (Node/TS host plugin)
  ↓ JSON Lines over stdio (id-correlated, concurrent)
bridge/verifier_brain_bridge.py (ThreadPool × N)
  ↓
llm-verifier 0.2.0 (official PyPI package)
  ↓ logprobs backend (OpenAI-compatible / DeepSeek / Vertex / Gemini)
```

## 三大应用场景

| 场景 | 用法 | 说明 |
|---|---|---|
| 测试时扩展 | `verifier` action=`select` | N 个候选方案 → PPT 锦标赛 O(Nk) 选优 |
| 进度跟踪 | `verifier` action=`progress_*` | 每步实时打分；持续 <0.05 = 方向可能错了 |
| 质量门禁 / RL | `verifier` action=`compare` / `track` / 分数落盘 | 成对评审、整轨迹复盘、reward 数据导出 |

一个工具，九个 action：`select` / `compare` / `track` / `progress_start` / `progress_update` / `progress_close` / `task_start` / `task_status` / `usage`。对 agent 说 "verifier compare 一下" 即可。

## 安装

需要 Node 18+（engines 声明 `>=18`）、Python 3.10+、一个能返回 logprobs 的后端凭据。

### 一键安装（推荐）

```sh
git clone https://github.com/Animal2404/dsh-verifier-Pro.git
cd dsh-verifier-Pro
node scripts/setup.mjs --check    # 诊断：告诉你缺什么、推荐适合你凭据的评分后端配置
node scripts/setup.mjs --fix      # 自动修复：建 .venv + 安装 llm-verifier
```

`--check` 会根据你在 `~/.dsh/.credentials.yaml` 里已有的凭据**自动推荐评分后端配置**
（有 DEEPSEEK_API_KEY → 推荐 deepseek-chat @ api.deepseek.com；有 OPENCODE_GO_API_KEY →
推荐 opencode + deepseek-v4-flash-vision-exp；都没有 → 给出申请地址），并直接对比当前硬编码值，
把"装完不能直接用"的根源指出来。按它给的片段改 `cordis.patch.yml` 两行即可适配你的环境。

### 手动安装（等效于 --fix 做的事）

```sh
# 1) Python 侧：官方 llm-verifier 装进项目 venv
python -m venv .venv
.venv/Scripts/python -m pip install llm-verifier     # Windows
# .venv/bin/python -m pip install llm-verifier        # macOS/Linux

# 2) 构建
bash scripts/build.sh

# 3) 挂载到 profile（重启 dsh 生效）
#    或用 dsh plugin --profile web add <this package>
```

### 评分后端配置（重要！）

默认配置里的评分模型/端点是**作者的环境**——你需要按自己持有的凭据修改
`cordis.patch.yml` 的 `verifierModel` / `backendBaseUrl` 两行：

| 你有的凭据 | verifierModel | backendBaseUrl | 实测状态 |
|---|---|---|---|
| `DEEPSEEK_API_KEY`（DeepSeek 官方） | `deepseek-chat` | `https://api.deepseek.com` | ✅ 推荐 |
| `OPENCODE_GO_API_KEY`（opencode） | `deepseek-v4-flash-vision-exp` | `https://opencode.ai/zen/go/v1` | ✅ 实测可评分 |
| `OPENROUTER_API_KEY` | `deepseek/deepseek-chat` | `https://openrouter.ai/api/v1` | 未验证 logprobs |

> 📌 **模型评分路径（v0.5.0）**：
> - **logprobs 路径（精确）**：`deepseek-v4-flash-vision-exp`（默认）、`qwen3.7-plus`、`qwen3.6-plus`。
> - **literal-mc 路径（采样近似，模型不返回 logprobs 时的降级）**：`minimax-m3`、`minimax-m2.7`、
>   `mimo-v2.5-pro`、`muse-spark-1.2-contributor`、`deepseek-v4-flash`（桥自动路由，见下）。
> - `deepseek-v4-flash` 本身仍不接受 logprobs 请求（DFLASH 400），但桥会**自动走 literal-mc
>   采样评分**（无 logprobs 直调 + 读评分标签 + K 次采样平均），因此可用——不再是「勿用」。
>
> 要求：logprobs 路径的模型必须支持 **token 级 logprobs 返回**（细粒度 reward 的根基）。
> literal-mc 路径的模型则要求能按提示词输出 `<score_X>` 字母标签（桥自动探测/按档案路由）。
> 面板会标注本次评分用的是哪条路径；精细判别建议用 logprobs 模型。

要求：所选模型必须支持 **logprobs 返回**（这是细粒度 reward 的根基）。跑一次
`.venv/Scripts/python scripts/probe_logprobs.py <model> <base_url> <api_key>` 可验证你的端点是否返回 logprobs；
或用 `.venv/Scripts/python scripts/scan_logprob_models.py <你的key>` 批量扫描候选模型
（macOS/Linux 用 `.venv/bin/python`）。

## 使用

对 agent 说话即可，system prompt 策略会引导它自动调用：

> 这里有三个方案，用 verifier 选最好的一个，然后取长补短合并成一版
> （agent → verifier select 排名 → 整合代理合并 → verifier compare 门禁）

> 用 AgentTeams 做一个团队 Best-of-N：三个成员各写一版，verifier 选优后合并
> （队长 fan-out → verifier select → 整合 pass → 最终 compare 门禁）

> 这个任务跑很久了，随时告诉我进展离完成有多近
> （agent → verifier progress_start/update，持续低分会建议换策略）

### Best-of-N = 合并，不只是评比

不同代理产出的候选往往各有所长。插件内建的策略是三步闭环：

1. **排名**：verifier select（大候选池）或 verifier compare（2-3 个候选，更便宜且区分度更好）；
2. **合并**：不直接采纳冠军——把**全部候选 + 各自分数**交给一个整合代理（独立成员或队长另开一轮），综合出各取所长的合并版；
3. **门禁**：verifier compare(合并版, 原冠军)——合并版得分不低于冠军才采纳，否则回退冠军并说明原因。分数随结果一并报告，不虚构不抹平。

verifier 只做 reward 函数，不做写手；整合由代理完成——这是刻意的设计边界，避免过度工程化。

### /bestofn 一键命令（团队 Best-of-N 优选）

一条命令跑完整"优中选优"闭环——派 N 个成员完整实现同一任务，证据链淘汰崩溃候选，
verifier select 细粒度优选，整合合并，compare 门禁：

```
/bestofn <goal> [N]                        # 团队模式：派 N 成员完整实现 → 证据链 → select → 合并 → 门禁
/bestofn <goal> -n 5                        # 指定成员数
/bestofn --local <c1> <c2> ... [--summary]  # 本地模式：对已有候选跑证据链 → select → 报告
```

- 团队模式：命令激活后你（队长）按 7 步协议执行——派 N 成员（每个**完整实现**，禁止分工切面）→
  收集产物 → 每份跑证据链（崩溃出局）→ 幸存者 select → 整合合并 → compare 门禁 → 交付分数报告。
- 本地模式：对工作区已有的 HTML/JS 候选直接跑证据链 → select，适合快速对比手头方案。
- select 触发自适应 K 升级时，报告会附 `escalated / k_used / margin_before / margin_after`；
  出现 `signal:"flat"` 时排名无信号，必须用 compare 复核前二名。

### 证据链自动化（M3）

可运行产物在进 verifier 评分前先过证据链——**证据先行，崩溃出局**：

```sh
# 一键端到端：冒烟（HTML/CDP 或 Node.js）→ 五维视觉描述 → 证据拼接（带来源标注）
node scripts/evidence_chain.mjs <artifactOrDir...> --summary <name>=<自述>

# 分步执行
node scripts/smoke.mjs <artifactOrDir...>            # 冒烟：错误/退出码/stdout/stderr/截图
node scripts/describe_visual.mjs <screenshot.png>    # 五维视觉描述（色彩/氛围/细节密度/风格化/第一印象）
node scripts/build_evidence.mjs <artifact> ...        # 证据拼接："候选自述" vs "运行时观察（非候选自述）"
```

- 支持的产物类型（评审收窄）：**HTML**（CDP 开屏 + 控制台错误 + N 帧 update + 截图）与
  **Node.js**（child_process + 退出码 + stdout/stderr）；其余标记为实验性。
- 崩溃候选（smoke `ok:false`）**直接出局，不参与评分**——verifier 只消费带证据的幸存者。
- 证据块明确区分"功能摘要（候选自述）"与"运行时/视觉观察（非候选自述）"，防止自述污染评分。

### 实战调用纪律（首轮真实使用沉淀）

- 同步工具共享 300s 预算；3+ 候选 / 大载荷一律走 verifier task_start（异步任务独立 30min 预算），并先压缩载荷（去注释、留主干）。
- 轮询用 task_status 的 `wait_seconds=120` 长轮询，不要盲轮。
- select 返回全等分数时会带 `signal:"flat"`——排名无信号，必须用 pairwise compare 复核前二名后再采信。

## 配置（cordis.patch.yml / 插件配置）

```yaml
- insert:
    - id: verifier-brain
      name: '@dsh-external/dsh-verifier-pro'
      config:
        bridgeTimeoutMs: 300000
        verifierModel: deepseek-v4-flash-vision-exp
        maxWorkers: 4
        promptSection: true
```

| 项 | 默认 | 说明 |
|---|---|---|
| `pythonBin` | 自动探测 `.venv` | Python 可执行文件 |
| `bridgeTimeoutMs` | `300000` | **同步**工具调用的桥超时 |
| `taskTimeoutMs` | `1800000` | **异步**任务的超时预算（长锦标赛评分） |
| `verifierModel` | 官方后端默认 | 默认 verifier 模型 |
| `backendBaseUrl` / `backendApiKey` | 凭据自动 | 显式 OpenAI 兼容后端 |
| `maxWorkers` | `4` | 桥内并发 worker |
| `stateDir` | `~/.dsh/verifier-brain` | 持久化目录（history/tasks JSONL） |
| `promptSection` | `true` | 注入使用策略到 system prompt |
| `maxCostPerVerification` | `0` (无限制) | 单次验证最大成本（美元）—— **v0.6.0 实现预算拦截，当前为预留配置项（暂不生效）** |
| `costPer1kInputTokens` | `0` | 每 1K 输入 token 成本（美元），用于成本估算（预留） |
| `costPer1kOutputTokens` | `0` | 每 1K 输出 token 成本（美元），用于成本估算（预留） |

### 配置详解（这个文件是干嘛的、怎么改）

`cordis.patch.yml` 是 DSH 的**补丁层**：插件的这份文件（随包分发）声明「把插件挂进 profile 的加载组合」。核心结构：

```yaml
- insert:                      # 顶层必须是 insert 列表
    - id: verifier-brain       # 加载条目 id（插件内唯一标识）
      name: '@dsh-external/dsh-verifier-pro'  # 可被 Node 解析的包名，须与 package.json name 一致
      config: { ... }          # 注入给插件 apply() 的配置对象（上表字段都在这里）
```

**改配置的两种方式**：
1. **改 profile 补丁**（推荐）：编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`，对 `verifier-brain` 条目覆盖字段。改完重启 dsh 生效。
2. **改插件自带的补丁**：直接改本文件后重新安装——会作为 bundle patch 应用到所有装它的 profile。

**切换 LLM 后端的步骤**（例如从 opencode 切到 DeepSeek 官方）：
1. 确认 `~/.dsh/.credentials.yaml` 里有对应凭据（`DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY` / `VERTEX_API_KEY`）
2. 改 `backendBaseUrl` + `verifierModel` 指向目标后端（表见「后端对照」节）
3. 重启 dsh
4. 跑一次 `compare` 验证：`probe` 会先探测 logprobs 支持，不支持的后端会直接报错（不烧钱）

**分级评分（可选，省钱的进阶配置）**：设置 `escalationModel` 后，只有分差落噪声带的升级轮会用这个「更强模型」，首评保持廉价档。留空 = 升级轮复用 `verifierModel`。

> ⚠️ 改完配置必须重启 dsh（配置在加载时读取，热重载不重读配置）。

## 版本钉扎指引

为避免 `dsh plugin add github:Animal2404/dsh-verifier-Pro` 拉取最新 main 分支导致不兼容变更，**强烈建议使用 commit hash 钉扎版本**：

```sh
# 钉扎到特定 commit（推荐）
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro#a1b2c3d

# 或钉扎到 tag（如 v0.4.2）
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro@v0.4.2
```

> ⚠️ 不加 `#commit` 或 `#tag` 将始终拉取最新 main，可能引入破坏性变更。

## 性能基准（实测，非估算）

以下数据来自 `~/.dsh/verifier-brain/history.jsonl` 的真实调用统计（94 次评分），
后端 opencode `deepseek-v4-flash-vision-exp`，单并发：

| 操作 | 样本 | 中位耗时 | 范围 | 说明 |
|---|---|---|---|---|
| `compare`（两两对比） | 59 | **10.8s** | 1.9–72.3s | 单次评分；分差落噪声带会自动升级 K=3，耗时会放大 |
| `select`（N 候选排名） | 23 | **37.8s** | 2.7–117.5s | PPT 锦标赛；3 候选 n=1 pivots=2 约 30-40s |
| `track`（轨迹评分） | 2 | **2.6s** | 1.6–2.6s | 短轨迹 |
| `decompose`（分解验证） | 实测 | **30–65s** | — | 输出长（步骤摘要+错误分类+核查问题），max_tokens 4096 |

**影响耗时的因素**：
- `n_evaluations`（每候选评分次数，默认 1）→ 线性放大
- `pivots`（锦标赛枢轴，默认 2）→ 锦标赛规模
- 自动升级（分差落噪声带 → K=3）→ 约 3 倍
- **literal-mc 模型**（minimax/mimo 等）：默认 K=5 采样 = 5 次调用

**成本估算**（opencode 计价，约 ¥0.3/百万 token 输入档）：
- 一次 `compare` 约 2-5K token → 成本可忽略（<¥0.01）
- 一次 `select`（3 候选）约 10-20K token → ~¥0.01 量级
- 大规模批量使用时，literal-mc 的 K=5 会是主要成本因子（5×调用次数）

> 想压成本/延迟：`n_evaluations=1` + 短 criteria + 大载荷走异步任务（不阻塞 agent）。

## 常见错误排查（FAQ）

按「出问题的层」分层诊断——`verifier` 工具报错时先定位是哪一层：

### 层 1：LLM 后端（最常见）

| 错误特征 | 原因 | 解决 |
|---|---|---|
| `DFLASH speculative decoding does not support return_logprob` (400) | 用了 `deepseek-v4-flash`（上游禁 logprobs）| 换 `deepseek-v4-flash-vision-exp` 或 qwen3.7/3.6-plus |
| `Range of top_logprobs should be [0, 5]` (400) | qwen 系模型 top_logprobs 上限 5 | 自动处理（桥已按模型裁剪）；若手动传参别超 5 |
| `Invalid API key` (401) | 后端凭据缺失/错误 | 检查 `~/.dsh/.credentials.yaml` 对应 key；`setup.mjs --check` 会诊断 |
| `no answer logprobs` | 模型不返回 token 级 logprobs（muse/minimax 等）| 插件自动走 literal-mc 降级；仍失败则换模型 |
| 所有候选精确 0.5（degraded）| 评分批量失败被 tie 掩蔽 | 换后端/模型重试 |

### 层 2：Python 桥

| 错误 | 原因 | 解决 |
|---|---|---|
| `llm-verifier is not installed` | .venv 缺包 | `.venv/Scripts/python -m pip install "llm-verifier>=0.2.0"` |
| `python bridge timed out after 30000ms` | 桥首次建连或模型响应慢 | 重试；确认模型可用（见层 1）|
| `Connection error` | 桥进程异常退出 | 会自动重启；仍不行重启 dsh |

### 层 3：DSH 宿主 / 配置

| 错误 | 原因 | 解决 |
|---|---|---|
| 工具不存在 / 未注册 | 插件未装配 | 检查 `cordis.patch.yml` 的 insert 条目；重启 dsh |
| 改配置不生效 | 配置加载时读取 | **重启 dsh**（热重载不重读配置）|
| `Cannot find module` | 依赖链接缺失 | 重跑 `scripts/build.sh`（会重建 node_modules 链接）|

> 通用排查顺序：**先看错误信息是哪层的**（401/400=后端，timeout/Connection=桥，module/未注册=宿主），
> 别从 Node 环境开始猜。`setup.mjs --check` 会一次性诊断后端凭据 + .venv + lib 产物。

## 命名说明

项目名 `dsh-verifier-Pro` 与内部文件名 `verifier_brain_bridge.py` 不一致是历史遗留：
插件最初叫 verifier-Pro，重构时引入了更精确的「brain」内部命名（`dsh-verifier-brain` 目录、
`bridge/verifier_brain_bridge.py`），但仓库名未同步改。二者指同一插件；以 `package.json` 的
`@dsh-external/dsh-verifier-pro` 为准。依赖版本：`llm-verifier` 以 `>=0.2.0` 约束（桥侧有最低
版本检查，过旧会明确报错）。

## 端到端示例（从装到用）

```bash
# 1) 安装（推荐钉扎）
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro@v0.5.0

# 2) 检查环境（凭据 + .venv + 产物一次诊断）
cd E:/DeepSeek/dsh-verifier-brain && node scripts/setup.mjs --check

# 3) 重启 DSH 让配置生效
# 4) 在任意会话让 agent 调用 verifier（说人话即可）：
#    "用 verifier 对比这两个方案哪个好" → compare
#    "给这三个实现排个名"            → select
#    "复盘这条轨迹哪里有问题"        → decompose
#    "给这段会话打个分"              → evaluate_session

# 5) 面板：工具结果以卡片显示（徽章/分数/验证锚定等级/采样提示）
# 6) 需要审计时：评分历史在 ~/.dsh/verifier-brain/history.jsonl
```

### criteria 写法（重要）

`criteria` 只接受**描述对象**——每个键是标准名，值是打分标准的自然语言描述：

```json
{
  "Correctness": "输出是否事实正确",
  "Completeness": "是否完整覆盖需求",
  "Clarity": "表达是否清晰"
}
```

> ⚠️ **不支持权重对象**（如 `{"Correctness": 0.5, ...}`）：llm-verifier 后端把 criteria 值当作描述文本处理，数值会被字符串化成无意义的 `"0.5"` 标准。传入全数值对象时工具会**直接报错拒绝**，请改用描述对象。若确需加权，请在问题文本（`problem`）中显式说明各维度的相对重要性。

## 参考项目

本项目参考了以下项目与文档（同路线先驱与协作底座）：

| 项目 | 说明 |
|---|---|
| [llm-as-a-verifier/llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) | 官方框架本体：logprob 期望 reward（select / compare / track / ProgressTracker），通过 PyPI 包 `llm-verifier` 直接复用 |
| [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 多智能体协作"躯干"（队长/成员/任务板）；集成方式：system prompt 策略段 + 服务调用，不合并不 fork |
| [uson1x/dsh-plugin-llm-verifier](https://github.com/uson1x/dsh-plugin-llm-verifier) | 纯 Node 评分器 + `verify_rollout`（并行 N 尝试）的产品形态参考；不采用其无 logprobs 的技术路线 |
| [lanbaolu/dsh-llm-verifier](https://github.com/lanbaolu/dsh-llm-verifier) | 同路线先驱：Python stdio 桥 + DSH 插件；吸收其桥协议与工具契约，独立重写并修其三大短板 |
| [lanbaolu/dsh-llm-verifier docs/PROGRESS.md](https://github.com/lanbaolu/dsh-llm-verifier/blob/HEAD/docs/PROGRESS.md) | 先驱开发进度记录 |
| [lanbaolu/dsh-llm-verifier docs/PLAN.md](https://github.com/lanbaolu/dsh-llm-verifier/blob/HEAD/docs/PLAN.md) | 先驱架构与关键决策 |
| [lanbaolu/dsh-llm-verifier docs/ROADMAP.md](https://github.com/lanbaolu/dsh-llm-verifier/blob/HEAD/docs/ROADMAP.md) | 先驱路线图 |

## 相对参考实现的差异

相对上述参考实现，本项目的增量：**桥内并发**（异步任务不再串行排队）、
**状态落盘**（重启不丢）、**Windows 一等公民**、**桥崩溃自重启**、**团队集成协议**
（best-of-N / reviewer 门禁 / 进度传感器写进 system prompt）、**自适应验证缩放**
（分差落噪声带自动 K=3 重评并如实上报评估次数）、**证据链自动化**
（冒烟+视觉描述+来源标注，崩溃候选出局）、**/bestofn 一键优选命令**
（团队 fan-out 或本地候选，完整"选优→合成→验证→门禁"闭环）。

## 服务化接口

其他插件可直接消费 `ctx.verifierBrain`（`select` / `compare` / `track` /
`progressStart` / `progressUpdate` / `progressClose` / `usage` / `ping`），
不必经过模型可见工具。

## 工具脚本

- `scripts/probe_logprobs.py` — 探测任意 OpenAI 兼容端点是否返回 logprobs
- `scripts/e2e_bridge_test.py` — 桥全流程端到端测试（单进程，含 ProgressTracker）
- `scripts/acceptance_ts.mjs` — 自适应升级十用例验收回归（ITERATION_PLAN §3）
- `scripts/evidence_chain.mjs` — 证据链一键端到端（冒烟→视觉描述→证据拼接）
- `scripts/smoke.mjs` — 泛化冒烟（HTML/CDP 与 Node.js 两类）
- `scripts/describe_visual.mjs` — 五维视觉描述（色彩/氛围/细节密度/风格化/第一印象）
- `scripts/build_evidence.mjs` — 证据拼接（"候选自述" vs "非候选自述"来源标注）
- `scripts/test_bestofn.mjs` — /bestofn 命令双模式验证

## License

BSD-3-Clause
