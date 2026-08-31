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
  ↓ verifier 工具（单一工具 × 12 action：select/compare/track/decompose/evaluate_session/progress_*/task_*/usage/config）
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

一个工具，十二个 action：`select` / `compare` / `track` / `decompose` / `evaluate_session` / `progress_start` / `progress_update` / `progress_close` / `task_start` / `task_status` / `usage` / `config`。对 agent 说 "verifier compare 一下" 即可。

## 安装

需要 Node 18+（engines 声明 `>=18`）、Python 3.10+、一个能返回 logprobs 的后端凭据。

### 一键安装（推荐）

```sh
git clone https://github.com/Animal2404/dsh-verifier-Pro.git
cd dsh-verifier-Pro
node scripts/setup.mjs --check    # 诊断：告诉你缺什么、推荐适合你凭据的评分后端配置
node scripts/setup.mjs --fix      # 全自动：建 .venv → 装 llm-verifier → 双写推荐配置 →
                                  #         构建 lib/ → 挂载到 profile（默认 web）
```

`--fix` 跑完即完成全部六步：① 创建 .venv → ② pip 安装 llm-verifier → ③ 复核 →
④ 把适合你凭据的 `verifierModel` / `backendBaseUrl` **双写**到仓库补丁和 profile 补丁
（实际生效层，见「配置详解」）→ ⑤ `npm run build` 构建 lib/ → ⑥ 检测到 dsh CLI 时自动
执行 `dsh plugin --profile web add <目录>`。然后**重启 dsh** 即生效；Web 页面如已打开，
**刷新一次浏览器标签**以加载面板 bundle。

常用旗标：

| 旗标 | 作用 |
|---|---|
| `--profile <名称>` | 挂载目标 profile（默认 `web`） |
| `--no-mount` | 只做到构建为止，不自动挂载 |
| `--check --strict` | 存在待处理项时 exit 1（CI/脚本化预检用；普通 `--check` 恒 exit 0） |
| `--bench` | 判别力自检（见下文 G1 小节）：换评分模型后的质量回归门 |

`--check` 会根据你在 `~/.dsh/.credentials.yaml` 里已有的凭据**自动推荐评分后端配置**
（有 DEEPSEEK_API_KEY → 推荐 deepseek-chat @ api.deepseek.com；有 OPENCODE_GO_API_KEY →
推荐 opencode + deepseek-v4-flash-vision-exp；都没有 → 给出申请地址），并直接对比当前硬编码值，
把"装完不能直接用"的根源指出来。

> 💡 **30 秒冒烟**：装完重启 dsh 后，对 agent 说「用 verifier 对比一下 X 和 Y 哪个好」——
> 能看到 verifier compare 工具卡片（分数 + 徽章）就是活的。

### 手动安装（等效于 --fix 做的事）

```sh
# 1) Python 侧：官方 llm-verifier 装进项目 venv
python -m venv .venv
.venv/Scripts/python -m pip install llm-verifier     # Windows
# .venv/bin/python -m pip install llm-verifier        # macOS/Linux

# 2) 构建（纯 Node 入口，Windows 无需 bash；build.sh 保留给 bash 用户）
npm run build

# 3) 挂载到 profile（重启 dsh 生效）
#    或用 dsh plugin --profile web add <this package>
```

> **开发装配说明（重要）**：本仓库的开发安装依赖 DSH 宿主注入器的 junction 机制——`node_modules` 里
> 的 `cordis`/`cosmokit`/`schemastery` 与 `@deepseek-ai/dsh-llm` 等 peer 是**指向宿主全局安装的链接**
> （保证插件始终用宿主同版本 API），`react`/`tsdown`/`typescript` 链接到本地 `.pnpm` 虚拟存储。
> 因此：**`npm ci`/`npm install` 不是受支持的装配方式**（`package-lock.json` 未入库、不包含 peer 树）；
> 本地开发用 `dev_install_package` / 超级模组注入器挂载即可。**宿主升级大版本后**，这些 junction 的
> 目标路径会变化，需重新注入/重挂一次（`dev_reload_package` 或重新 `dev_inject_plugin`）。

### 评分后端配置（重要！）

默认配置里的评分模型/端点是**作者的环境**——你需要按自己持有的凭据修改
`cordis.patch.yml` 的 `verifierModel` / `backendBaseUrl` 两行：

| 你有的凭据 | verifierModel | backendBaseUrl | 实测状态 |
|---|---|---|---|
| `DEEPSEEK_API_KEY`（DeepSeek 官方） | `deepseek-chat` | `https://api.deepseek.com` | ✅ 推荐（logprobs 分布未在本仓实测，建议先跑 probe 验证） |
| `OPENCODE_GO_API_KEY`（opencode） | `deepseek-v4-flash-vision-exp` | `https://opencode.ai/zen/go/v1` | ✅ 实测可评分 |
| `OPENROUTER_API_KEY` | `deepseek/deepseek-chat` | `https://openrouter.ai/api/v1` | 未验证 logprobs |

> 📌 **模型评分路径（现行）**：
> - **logprobs 路径（精确）**：`deepseek-v4-flash-vision-exp`（默认）、`qwen3.7-plus`、`qwen3.6-plus`。
> - **literal-mc 路径（采样近似，模型不返回 logprobs 时的降级）**：`minimax-m3`、`minimax-m2.7`、
>   `mimo-v2.5-pro`、`muse-spark-1.2-contributor`、`deepseek-v4-flash`（桥自动路由，见下）。
> - `deepseek-v4-flash` 本身仍不接受 logprobs 请求（DFLASH 400），但桥会**自动走 literal-mc
>   采样评分**（无 logprobs 直调 + 读评分标签 + K 次采样平均），因此可用——不再是「勿用」。
> - **档案自愈（fail-closed）**：literal-mc 模型连续 3 次未输出评分标签即判 DEGRADED——拒绝评分
>   而非静默错评；probe 复核通过可自动恢复。
>
> 要求：logprobs 路径的模型必须支持 **token 级 logprobs 返回**（细粒度 reward 的根基）。
> literal-mc 路径的模型则要求能按提示词输出 `<score_X>` 字母标签（桥自动探测/按档案路由）。
> 面板会标注本次评分用的是哪条路径；精细判别建议用 logprobs 模型。
>
> **默认模型判别力实测（2026-08-23，A/B 对照）**：默认的 `deepseek-v4-flash-vision-exp`
> 与 `deepseek-v4-pro` 在粗判别（sumTo 循环 vs 公式）、细判别（fib 递归 vs 迭代，
> 双方均正确）、中文判别（中文实现+中文 criteria）三个任务上**方向判定全部一致且正确**，
> flash-vision-exp 的 margin 甚至更大（0.46/0.49/0.31 vs 0.35/0.41/0.21）。
> 早期曾观察到 flash-vision-exp 在细判别任务上 flat（0.499/0.500）——该问题已被
> **reason-first 提示词**（评分前先分步推理再给 `<score_X>`，见 bridge/bridge_fix.py）
> 修复。默认模型无需更换。

要求：所选模型必须支持 **logprobs 返回**（这是细粒度 reward 的根基）。跑一次
`.venv/Scripts/python scripts/probe_logprobs.py <base_url> <api_key> <model>` 可验证你的端点是否返回 logprobs；
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

### /bestofn 一键命令（团队 Best-of-N 优选 · v0.7.0 双轨）

一条命令跑完整"优中选优"闭环。v0.7.0 起按交付物类型**自动分轨**——两种轨道的成功定义不同：

```
/bestofn <goal> [N]                        # BUILD 轨：派 N 成员完整实现 → 计划门禁 → 证据链 → select → 修订环 → 合并 → 门禁
/bestofn <goal> -n 5                        # 指定成员数（≤8，超出静默截断并提示）
/bestofn --local <c1> <c2> ... [--summary name=text]  # 本地模式：对已有候选跑证据链 → select → 报告
/bestofn <审计目标描述>                      # AUDIT 轨：交付物是报告时自动切换
```

**BUILD 轨**（可运行产物）：派 N 个**透镜分化**的成员（最大胆设计 / 最防御设计 / 性能与边界案例——任务范围完整一致，只有视角不同）→ **计划门禁**（先比方案、败方优点并入胜方再实现）→ 每份产物过证据链（崩溃出局、无记录=unknown 排除）→ `select("deep_review")` → **修订环**（发现的问题原样派回成员带证据修复→复评，上限 2 轮）→ 整合全部幸存者 → compare 门禁。

**AUDIT 轨**（报告/分析类交付物）：范围冻结 + 反污染（审本项目禁止读历史审计文档）→ 并行审计（每条发现必须引用 file:line + 原文片段）→ 队长机械核验 ≥30% 引用 + 全部致命发现（伪造即无效并减半成员权重）→ 强制交叉审阅 → `select("root_cause")` → 最终报告逐条标注 **VERIFIED / REPORTED**。

**稳定候选标签**：select 结果带 `tags`、compare 带 `tag_a/tag_b`（候选文本 sha256 前 12 位）。连续多轮评选拼子集时，位置字母会换指代而标签不变——按标签即可把第二轮的 A/B 对回第一轮的身份。

其他协议升级：预算门禁（开跑前声明 N 与 maxCostPerVerification）、修订环闭环（验证不闭环 = 昂贵的橡皮图章）、深度纪律条款（浅而全必须输给深而准）。

### /vselftest 一键自检（v0.7.0+）

零参数对插件自身发起 AUDIT 轨团队审计（写死目标：bestofn↔smoke 协作边界；N=2 透镜成员；引用核验全开）：

```
/vselftest                # 默认聚焦：artifactName 哈希 ↔ smokeOk 查找 + parseArgs 边角
/vselftest 重点查 XXX      # 自定义聚焦点
```

这是插件"用自己的教条测自己"的入口——首轮实战就抓出了 4 个人工三轮审计都漏掉的 bug。

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

- 支持的产物类型：**HTML**（CDP 开屏 + 控制台错误 + N 帧 update + 截图）与
  **Node.js**（.js/.mjs/.cjs，child_process + 退出码 + stdout/stderr）；其他类型
  （.md/.txt 等）标记为 ⏭️ **unsupported 跳过**（不执行、不计失败，v0.7.0 起）。
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
        taskTimeoutMs: 1800000
        verifierModel: deepseek-v4-flash-vision-exp
        backendBaseUrl: https://opencode.ai/zen/go/v1   # 按你持有的凭据修改（见下表）
        maxWorkers: 4
        promptSection: true
        autoEscalate: true
        escalateThreshold: 0.15
        maxEscalateK: 3
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
| `maxCostPerVerification` | `0` (无限制) | 单次验证最大成本（美元）—— **v0.6.0 起已实现预算拦截**：基于 history 真实耗时×费率估算，超预算拒绝；**v0.7.0 起覆盖全部评分路径**（同步 select/compare/track、异步 task_start、服务缝、/bestofn） |
| `costPer1kInputTokens` | `0` | 每 1K 输入 token 成本（美元），预算拦截的费率输入 |
| `costPer1kOutputTokens` | `0` | 每 1K 输出 token 成本（美元），用于成本估算 |
| `autoEscalate` / `escalateThreshold` / `maxEscalateK` | `true` / `0.15` / `3` | 自适应验证缩放（分差落噪声带自动 K 重评） |
| `escalationModel` | 空 = 同 verifierModel | 分级评分：仅升级轮使用的更强模型 |
| `maxWorkers` 并发语义 | — | 既限桥请求并发，也作为官方内层打分 fan-out 的默认 `max_workers`（v0.7.4 起）；显式传参可到 16 |

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

**凭据 → 后端解析机制（M-6：改了 backendBaseUrl 之后 key 从哪来）**

桥进程的 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 按以下优先级合成（显式者永远覆盖自动探测）：

1. **插件配置显式值**（最高）：`cordis.patch.yml` 的 `backendBaseUrl` / `backendApiKey`——这就是你的后端选择；
2. **凭据文件** `~/.dsh/.credentials.yaml`：识别已知键名，兼容三种写法（扁平 `KEY: value`、
   `refs:` 节下缩进键、`provider:` + `api_key:` 嵌套节）；
3. **环境变量同名键**。

**baseUrl ↔ 凭据键的绑定关系**（与 setup.mjs 内置映射一致；自建端点必须显式填 `backendApiKey`）：

| 你配置的 `backendBaseUrl` | 桥找哪个 key |
|---|---|
| `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY`（别名转发为 OPENAI_API_KEY + 该 baseUrl） |
| `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| 其他（Vertex/Gemini/自建） | `OPENAI_API_KEY` / `VERTEX_API_KEY` / `GEMINI_API_KEY` 或显式 `backendApiKey` |

规则细节：同时持有多家凭据时，原生 provider 键优先于 opencode 别名——除非你把
`backendBaseUrl` 显式指到 opencode（此时该代理的凭据胜出，例如 DeepSeek 欠费时切过去）。
跑 `verifier usage` action 的 `config` 回显可查看当前生效组合。

**切换 LLM 后端的步骤**（例如从 opencode 切到 DeepSeek 官方）：
1. 确认 `~/.dsh/.credentials.yaml` 里有对应凭据（`DEEPSEEK_API_KEY` / `OPENCODE_GO_API_KEY` / `VERTEX_API_KEY`）
2. 改 `backendBaseUrl` + `verifierModel` 指向目标后端（表见「评分后端配置」节）
3. 重启 dsh
4. 跑一次 `compare` 验证：`probe` 会先探测 logprobs 支持，不支持的后端会直接报错（不烧钱）

**分级评分（可选，省钱的进阶配置）**：设置 `escalationModel` 后，只有分差落噪声带的升级轮会用这个「更强模型」，首评保持廉价档。留空 = 升级轮复用 `verifierModel`。

> ⚠️ 改完配置必须重启 dsh（配置在加载时读取，热重载不重读配置）。

## 版本钉扎指引

为避免 `dsh plugin add github:Animal2404/dsh-verifier-Pro` 拉取最新 main 分支导致不兼容变更，**强烈建议使用 commit hash 钉扎版本**：

```sh
# 钉扎到特定 commit（推荐）
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro#a1b2c3d

# 或钉扎到 tag（用【最新已发 tag】，见 Releases 页）
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro@<最新已发tag>
```

> ⚠️ 不加 `#commit` 或 `#tag` 将始终拉取最新 main，可能引入破坏性变更。

## 升级与卸载

**升级**（M-3）：

```sh
# 方式一：钉扎安装的——重跑 add 命令指到新 tag（推荐始终钉扎）
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro@<最新 tag>

# 方式二：clone 安装的——拉取后重建并重新挂载
cd dsh-verifier-Pro
git pull
node scripts/setup.mjs --fix        # 会重建 .venv 依赖、lib/ 并重新挂载
```

发布说明看 [Releases 页](https://github.com/Animal2404/dsh-verifier-Pro/releases)；
`main` 分支可能包含未发版变更，生产使用请钉扎最新已发布 tag。

**卸载与残留清理**（M-4 缩水项：本插件安装足迹比参考项目多几类，如实列出）：

| 残留物 | 位置 | 清理方式 |
|---|---|---|
| profile 补丁条目 | `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `- id: verifier-brain` 条目 | 手动删除该条目 |
| 安装副本 | profile 包目录内的插件目录 | `dsh plugin remove` 或删目录 |
| **评分历史（含提交给评分模型的候选全文，敏感）** | `~/.dsh/verifier-brain/history.jsonl`、`tasks.jsonl` | 删除整个 `~/.dsh/verifier-brain/` 目录 |
| Python 虚拟环境 | clone 目录下的 `.venv/` | 删除该目录 |
| 补丁备份 | `cordis.patch.yml.bak.*`（--fix 写配置时产生，保留最近 3 份） | 手动删除 |

> 🔒 隐私提示：`history.jsonl` 含候选全文与评分结果（SECURITY.md「评分数据出域」同源数据），
> 卸载插件不会自动清除；不再需要审计时建议删除。

## 性能基准（实测，非估算）

以下数据来自 `~/.dsh/verifier-brain/history.jsonl` 的真实调用统计（94 次评分），
后端 opencode `deepseek-v4-flash-vision-exp`，单并发：

| 操作 | 样本 | 中位耗时 | 范围 | 说明 |
|---|---|---|---|---|
| `compare`（两两对比） | 59 | **10.8s** | 1.9–72.3s | 单次评分；分差落噪声带会自动升级 K=3，耗时会放大 |
| `select`（N 候选排名） | 23 | **37.8s** | 2.7–117.5s | PPT 锦标赛；3 候选 n=1 pivots=2 约 30-40s |
| `track`（轨迹评分） | 2 | **2.6s** | 1.6–2.6s | 短轨迹 |
| `decompose`（分解验证） | 实测 | **30–65s** | — | 输出长（步骤摘要+错误分类+核查问题），max_tokens 8192 |

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
| `Cannot find module` | 依赖链接缺失 | 重跑 `npm run build`（纯 Node 入口 scripts/build.mjs，会重建 node_modules 链接）|

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
# 1) 安装（推荐钉扎；稳定版用【最新已发 tag】——见 Releases 页，勿凭记忆写版本号）
dsh plugin --profile web add github:Animal2404/dsh-verifier-Pro@<最新已发tag>
# 或 clone 后一键闭环（含构建+挂载，见「一键安装」节）：
#   git clone https://github.com/Animal2404/dsh-verifier-Pro.git && cd dsh-verifier-Pro
#   node scripts/setup.mjs --fix

# 2) 检查环境（在【你 clone 或安装】的插件目录里跑，路径按实际情况替换；
#    setup.mjs 会自动向上定位项目根，也可以用 --root 显式指定）
node scripts/setup.mjs --check

# 3) 重启 DSH 让配置生效（配置在加载时读取）；Web 页面如已打开，刷新一次浏览器标签
# 4) 在任意会话让 agent 调用 verifier（说人话即可）：
#    "用 verifier 对比这两个方案哪个好" → compare
#    "给这三个实现排个名"            → select
#    "复盘这条轨迹哪里有问题"        → decompose
#    "给这段会话打个分"              → evaluate_session
#    "当前生效的 verifier 配置是什么"  → config（只读回显）

# 5) 面板：工具结果以卡片显示（徽章/分数/验证锚定等级/采样提示）
# 6) 需要审计时：评分历史在 ~/.dsh/verifier-brain/history.jsonl
```

> ⚠️ **三份 cordis.patch.yml 的关系**（F-2）：① 你 clone 目录里的（`setup.mjs --fix` 写它）→
> ② `dsh plugin add` 随包分发进 profile 包目录的副本 → ③ `~/.dsh/profiles/<profile>/cordis.patch.yml`
> 是**实际生效层**、覆盖前两者。改配置认准 ③；`--fix` 会把推荐配置同时写进 ① 和 ③（存在才写）。

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

### 内置深度预设（v0.7.0+）

通用三件套（Correctness/Completeness/Clarity）奖励广度、惩罚洞察——LLM 评委天然偏袒「面面俱到的浅层候选」。评「哪个方案/分析**更好**」时请用内置预设（在进桥前自动展开为描述对象，同步/异步/服务缝全路径可用）：

| 预设名 | 维度 | 适用场景 |
|--------|------|----------|
| `deep_review` | 根因(带证据) · 证据锚定 · 失败模式与边界 · 权衡取舍 · 可执行性 | 方案择优、深度审查、计划门禁 |
| `root_cause` | 根因(带证据) · 证据锚定 · 影响面 | 缺陷分析、事故复盘 |

```
verifier select criteria="deep_review" problem="哪个实现更好？" candidates=[...]
```

未知名（如 `terminal_bench`）原样透传给官方包，行为不变。

**criteria `.md` 模板库（热加载，v0.7.4 起）**：`criteria/` 目录下的 `.md` 文件即模板——
`## 标准名` 二级标题为维度、正文为描述；传模板名即加载（如 `criteria="code_review"`）。
**每次评分即读盘，改完立即生效，无需重启**；目录里的 `deep_review.md` / `root_cause.md`
优先于代码内置同名预设（删文件即回退）。格式与示例见 `criteria/TEMPLATE.md`。

**判别力自检基准（G1，换模型后的质量回归门）**：probe 只验「能不能评」，不验「评得好不好」。
固定微任务集 A/B 对照（粗判别/细判别/中文/跑题拒绝，各 1 次 compare）实测评分方向是否正确：

```sh
node scripts/setup.mjs --bench     # 或直接: .venv/Scripts/python scripts/discriminative_check.py
python scripts/discriminative_check.py --model <你的模型> --base-url <你的端点> --key <key>
```

全部方向判定正确 exit 0；换评分模型后应跑一次。RELEASING 清单在更换默认评分模型时必跑。

> ✅ **默认模型实测（2026-08-26）**：`deepseek-v4-flash-vision-exp` @ opencode **4/4 全过**
> （粗判别 +1.000 · 细判别 +0.106 · 中文 +0.991 · 跑题拒绝 +1.000）。多模态 `images` 亦于同日
> 首次真实验证：红蓝方块带图 select 正确择红（scores 0.654 / 0.346）。

**多模态 `images` 参数的安全边界（B1，v0.7.5 起）**：`images` 是 agent 可控的本地文件路径，
默认不启用（文本端点自动剥离）。启用 `LLM_VERIFIER_ALLOW_IMAGES=1` 时，路径必须满足：
① 位于白名单根目录内——`LLM_VERIFIER_IMAGE_ROOTS`（`;`/`:` 分隔；缺省 = 进程 cwd + 系统
临时目录 + `DSH_HOME` + `~/.dsh`，覆盖证据链/冒烟产物与 /bestofn 产物所在位置）；② 单文件
≤ `LLM_VERIFIER_IMAGE_MAX_MB`（缺省 8MB）。TS 工具层与 Python 桥**双层校验**（前缀判定先
解析符号链接——白名单根内的 symlink 无法指向根外文件），违规路径响亮报错，绝不静默放行。
完整披露见 SECURITY.md「已知安全边界与设计取舍」。

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
- `scripts/acceptance_ts.mjs` — 自适应升级十用例验收回归（原 ITERATION_PLAN §3，已归档至 docs/HISTORY.md）
- `scripts/evidence_chain.mjs` — 证据链一键端到端（冒烟→视觉描述→证据拼接）
- `scripts/smoke.mjs` — 泛化冒烟（HTML/CDP 与 Node.js 两类）
- `scripts/describe_visual.mjs` — 五维视觉描述（色彩/氛围/细节密度/风格化/第一印象）
- `scripts/build_evidence.mjs` — 证据拼接（"候选自述" vs "非候选自述"来源标注）
- `scripts/test_bestofn.mjs` — /bestofn 命令双模式验证
- `scripts/audit_checks.mjs` — Playbook 机械化自检（28 项静态断言；`--full` 追加 npm test；发布前必跑，RELEASING.md 第 2 步）
- `scripts/mutation_check.mjs` — 回归测试保真度/变异验证（修复代码被变异后测试必须变红；假测试即发现；变异场景需仓库形态 tests/）

## License

BSD-3-Clause
