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
推荐 opencode + deepseek-v4-pro；都没有 → 给出申请地址），并直接对比当前硬编码值，
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
| `OPENCODE_GO_API_KEY`（opencode） | `deepseek-v4-pro` | `https://opencode.ai/zen/go/v1` | ⚠️ flash 已被禁 |
| `OPENROUTER_API_KEY` | `deepseek/deepseek-chat` | `https://openrouter.ai/api/v1` | 未验证 logprobs |

> ⚠️ **2026-08-22 起勿用 opencode 的 `deepseek-v4-flash` 打分**：上游为该模型启用了
> DFLASH 投机解码，拒绝一切 logprob 请求（400 "does not support return_logprob"）。
> 普通对话不受影响，但 verifier 打分必需 logprobs。同端点实测可用替代：
> `deepseek-v4-pro`、`qwen3.8-max`。

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
        verifierModel: deepseek-v4-pro
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

## 版本钉扎指引

为避免 `dsh plugin add github:Animal2404/dsh-verifier-Pro` 拉取最新 main 分支导致不兼容变更，**强烈建议使用 commit hash 钉扎版本**：

```sh
# 钉扎到特定 commit（推荐）
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro#a1b2c3d

# 或钉扎到 tag（如 v0.4.2）
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro@v0.4.2
```

> ⚠️ 不加 `#commit` 或 `#tag` 将始终拉取最新 main，可能引入破坏性变更。

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
