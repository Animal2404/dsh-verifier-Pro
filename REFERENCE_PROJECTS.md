# 参考项目全景对比 — dsh-verifier-brain

> 本文档系统整理 12 个参考项目（4 大类），逐一与 dsh-verifier-brain（原 dsh-verifier-Pro，v0.5.0）对比：
> 定位、核心机制、与我们的关系、可借鉴点、局限性。
> 用途：作为「复盘 + 自我评判」的外部锚点，也作为后续迭代方向清单。
> 生成日期：2026-08-23（基于各仓库 README 实读 + 本插件四轮 Best-of-N 审计结论）

---

## 目录

1. [我方基准：dsh-verifier-brain 能力画像](#0-我方基准)
2. [① 直接相关（llm-as-a-verifier 同源）](#1-直接相关llm-as-a-verifier-同源)
3. [② 过程奖励模型（PRM）](#2-过程奖励模型prm)
4. [③ LLM 评估与判断框架](#3-llm-评估与判断框架)
5. [④ AI 代理验证与质量保证](#4-ai-代理验证与质量保证)
6. [综合对比矩阵](#5-综合对比矩阵)
7. [借鉴优先级清单](#6-借鉴优先级清单)
8. [方向判断总结](#7-方向判断总结)

---

## 0. 我方基准

### dsh-verifier-brain 能力画像

| 维度 | 现状 |
|---|---|
| **定位** | DeepSeek Harness 的 LLM-as-a-Verifier 插件：细粒度验证（select/compare/track/progress/异步任务） |
| **评分机制** | ①官方 llm-verifier 包 **logprobs 细粒度 reward**（精确路径，默认）②**literal-mc 采样标签**降级路径（无 logprobs 模型，Round E 解锁 5 个模型）|
| **工具面** | 9 actions：select（PPT 锦标赛）/ compare / track / progress_start / progress_update / progress_close / task_start / task_status / usage |
| **防线** | clamp01 全链路 · anomaly/warning 透传 · exact-flat/degraded 护栏 · 自适应 K 升级（K=3 噪声带复核）· 并发闸门 · sanitize 传输层加固 · probe_model 预检（防 32K token 空烧）· top_logprobs 按模型裁剪 |
| **工程** | Windows 一等公民 · 状态落盘（history/tasks JSONL + 自动轮转）· 冷恢复垫片 · 桥崩溃自重启 · 凭据复用（credentials.yaml）· setup --fix |
| **生态** | /bestofn 团队协议（Best-of-N 全流程：三路独立 → 证据链 → select → 整合 → 门禁）· 网页面板（评分路径标注）· 评分路径透明（logprobs vs literal-mc）|
| **质量** | 四轮 Best-of-N 三方审计全清 · 30+ 回归测试 · v0.5.0 已发布 · CI 轻量冒烟 |

### 已知盲区（对比前的自我认知）

- **事实核查维度空白**：我们是「另一个 AI 打分」，不是「把声明与工具输出逐条核对」
- **无验证自主等级标注**：用户不知道「这分是 LLM 判断的还是机器证实的」
- **无 rubric 级反馈**：只给分，不给「为什么扣分」的结构化反馈
- **无对抗探针测试**：没有「故意注入看评分器是否被带偏」的测试

---

## 1. 直接相关（llm-as-a-verifier 同源）

### 1.1 uson1x/dsh-plugin-llm-verifier

- **仓库**：https://github.com/uson1x/dsh-plugin-llm-verifier
- **是什么**：专为 DeepSeek Harness 设计的 llm-as-a-verifier 插件（select/compare/track/rollout）
- **核心机制**：
  - **纯 Node 实现，无 logprobs**——Monte-Carlo 采样 + 多数投票（temperature 采样 K 次取多数）
  - 候选文本 **JSON 转义入槽**（防注入）——本仓库 SECURITY.md 早期虚报拥有、后来真实现的防御思路源头
  - 单点 normalizeScore 收敛（所有入口统一 clamp）
  - `AbortSignal.any` 真取消、`mapLimit` 有界并发、严格 config 校验、CI + mock 离线测试
- **与我们的关系**：同赛道直接竞品/平行实现
- **可借鉴**（已在 Round B/C/D 吸收）：
  - ✅ literal-mc 采样路径（Round E 落地为我们的降级评分）
  - ✅ JSON 转义/结构化槽位思想（我们实现为 sanitizeForVerifier 传输层加固）
  - ✅ 单点 normalize（我们实现为 clamp01 全链路）
- **我们超越**：logprobs 精确路径 · Windows 一等公民 · 状态落盘 · 面板 UI · /bestofn 团队协议
- **局限性**：无 logprobs 精确路径（采样精度上限）；无 dsh.bundle（装配依赖手工）

### 1.2 yxwan123/DeepVerifier

- **仓库**：https://github.com/yxwan123/DeepVerifier
- **是什么**：使深度研究代理（DRA）通过「测试时基于规则的反馈」（Rubric-Guided Feedback）自我进化，产生推理时缩放效应
- **核心机制**：
  - **验证不对称 + 分解**：把困难验证拆成小的、可溯源的问题
  - **Rubric 引导反馈**：DRA 失败分类学（5 大类 13 子类）→ 结构化 rubric → 可操作的修正意见（不是光给分）
  - 发布 DeepVerifier-4K SFT 数据集（4,646 对）训练反射/自我批判
- **与我们的关系**：竞争——都是「验证器」，但它走「规则 rubric + 反馈」路线，不走 logprobs
- **可借鉴**：⭐⭐ **rubric 级反馈**——我们只给分数，它给「为什么 + 怎么改」。方向：compare/track 结果加「分解成可核查子问题 + 每项 rubric 反馈」维度
- **我们超越**：即插即用（无需训练）· logprobs 精度 · 工程完备性
- **局限性**：依赖专有 Cognitive Kernel-Pro 体系；rubric 需人工构建分类学

### 1.3 open-compass/CompassVerifier

- **仓库**：https://github.com/open-compass/CompassVerifier
- **是什么**：轻量统一验证器模型（LLM 评估 + 结果奖励），多域（数学/知识/推理），支持 CoT 模式
- **核心机制**：
  - **专门训练的验证器模型**（非通用 LLM 当 judge）——更便宜、更准
  - 处理多子问题/公式/序列答案；识别异常/无效/长推理响应；对不同提示风格鲁棒
  - 发布 **VerifierBench** 基准（~100 万预测，专家标注）
- **与我们的关系**：竞争——验证器，但走「专训模型」路线
- **可借鉴**：⭐⭐ **异常响应检测**——我们只有 exact-flat 0.5 护栏；它系统性识别「异常/无效/长推理」响应。方向：probe 加「响应形态检测」（过长/空洞/非结构化）
- **我们超越**：即插即用（任意 logprobs 模型可评分）· 无训练成本 · DSH 深度集成
- **局限性**：需训练/下载专用模型；领域覆盖面依赖训练数据

---

## 2. 过程奖励模型（PRM）

### 2.1 RyanLiu112/GenPRM

- **仓库**：https://github.com/RyanLiu112/GenPRM
- **是什么**：生成式过程奖励模型——**先显式 CoT 推理 + 代码验证，再给过程判断**
- **核心机制**：
  - CoT 推理 + 代码验证作为过程判断的前置
  - **RPE（Relative Progress Estimation）**改进 Monte-Carlo 估计和硬标签
  - 并行 test-time scaling（多数投票）；可作 verifier 或 **critic**
  - 参数规模 1.5B–70B；23K MATH 训练数据
- **与我们的关系**：同理念（过程奖励）不同实现——它训练专门 PRM，我们把过程打分做成 track/progress 工具
- **可借鉴**：⭐⭐ **先推理再打分**——我们的评分是「直接让模型出字母」；它证明「先分步推理再判断」更准。方向：compare/select 提示词显式加「分步推理」结构
- **我们超越**：即插即用 · logprobs 精确 · 无需训练数据
- **局限性**：需训练；数学域偏向

### 2.2 mukhal/ThinkPRM

- **仓库**：https://github.com/mukhal/ThinkPRM
- **是什么**：长 CoT 过程奖励模型（1.5B/14B，R1-Distill-Qwen 微调），验证器在多数域内/域外优于 LLM-as-judge
- **核心机制**：在 1K 合成验证 CoT 上微调推理模型 → 验证器专用化
- **与我们的关系**：与 CompassVerifier 同向——「专用验证器 > 通用 judge」
- **可借鉴**：印证 CompassVerifier 方向。我们依赖通用模型评分是「judge 路线」，它们证明「验证器路线」在成本-精度曲线上有优势
- **我们超越**：即插即用（任何 logprobs 模型）· 多后端适配 · DSH 集成
- **局限性**：需训练；合成数据依赖

> **PRM 两项目共同启示**：「验证器应该被专门训练/提示」。我们的优势是零训练成本、即插即用；代价是精度依赖所用模型的判别力（本插件实测：判别力弱的模型在微妙任务上会 flat——logprobs 路径也救不了模型本身判别力不足）。

---

## 3. LLM 评估与判断框架

### 3.1 HiHelloAI/judge-llm

- **仓库**：https://github.com/HiHelloAI/judge-llm
- **是什么**：轻量可扩展 Python 框架，系统评估和对比 LLM 提供商（多轮对话、成本跟踪、全面报告）
- **核心机制**：
  - 多提供商注册表（Gemini/Google ADK/Mock/自定义）
  - 内置评估器：响应相似度、轨迹验证、成本/延迟检查、embedding 相似度、LLM-as-judge、子代理链验证
  - OpenTelemetry 可观测性
- **与我们的关系**：工具链互补——它是「离线评估框架」，我们是「运行时评分器」
- **可借鉴**：⭐⭐ **成本跟踪**——我们 history.jsonl 有 duration 但无 token 成本；config 里 maxCostPerVerification 是死配置（v0.6.0 待办）。方向：usage 工具升级为成本报告，激活死配置
- **我们超越**：运行时细粒度评分 · DSH 深度集成 · 证据链
- **局限性**：评估 vs 运行时评分是不同阶段；CC BY-NC-SA 许可（商用受限）

### 3.2 zhuochunli/Representation-as-a-judge

- **仓库**：https://github.com/zhuochunli/Representation-as-a-judge
- **是什么**：ICLR 2026 论文代码库——用**小模型内部表示（激活）**当评判器（语义容量不对称）
- **核心机制**：
  - Qwen3-1.7B 表示 + sklearn 分类器 → 5 维评分（语义一致性/逻辑性/信息量/流畅性/事实性，ROSCOE 框架）
  - 即插即用训练好的分类器；参考无关（reference-free）
- **与我们的关系**：理念颠覆——「不必用大模型当 judge」，用表示级信号
- **可借鉴**：观察项。若 DSH 未来暴露模型激活，这是全新评分维度。工程上与我们的「即插即用」哲学冲突（需训练分类器）
- **我们超越**：无需训练 · 可解释的文本级评分（logprobs 分布）· 多后端
- **局限性**：需训练；仅推理类任务验证；无 DSH 集成

---

## 4. AI 代理验证与质量保证

> ⭐ 这一类是**最值得借鉴**的——「事实核查」方向我们完全空白。

### 4.1 adepeju4/attest

- **仓库**：https://github.com/adepeju4/attest
- **是什么**：基于证据的评估工具——把代理的**每个声明**与工具**实际输出**逐条核对，验证事实（幻觉/工具滥用/安全疏漏）
- **核心机制**：
  - **声明-证据对照**：把回答拆成语句，逐条与工具真实输出核对（含具体证据行）
  - 4 问：编造了吗？工具用对了吗？被隐藏指令骗了吗？跑题了吗？
  - 关键论据：引用论文 *Gaming the Judge*（Khalifa et al., 2026）——**只重写推理不改事实，AI judge 误报率可升 90%**
- **与我们的关系**：互补/正交——它是事实核查，我们是质量评分
- **可借鉴**：⭐⭐⭐ **声明-证据对照**——与我们的 /bestofn 证据链天然契合（冒烟/截图/自述就是 receipts）。方向：bestofn 评分时把「候选自述」与「冒烟证据」逐条核对，抓「自述与证据矛盾」的候选
- **我们超越**：细粒度质量评分 · 团队协议 · 面板
- **局限性**：需要工具调用记录（我们 DSH 会话有，但 verifier 层没消费）

### 4.2 dunkyai/ai-validator

- **仓库**：https://github.com/dunkyai/ai-validator
- **是什么**：开源 AI 输出验证器——捕获幻觉、剥离叙述、验证工具调用；90+ 生产环境验证
- **核心机制**：response 声明 × toolCalls 记录对照（「说发了邮件」→ 查是否真调了 send 工具）；行为级验证
- **与我们的关系**：与 attest 同向——行为声明 vs 工具记录
- **可借鉴**：⭐⭐ 同样的声明-证据对照，聚焦「行为声明 vs 工具调用」。方向：track 工具打分时附带「该步声称调用的工具」核对
- **我们超越**：质量评分深度 · DSH 集成
- **局限性**：npm 生态（TypeScript），非 DSH 插件

### 4.3 assister-xyz/quality-oracle（AgentTrust）

- **仓库**：https://github.com/assister-xyz/quality-oracle
- **是什么**：挑战-响应测试评估 AI 代理和 MCP 服务器，6 维打分，颁发 W3C 可验证凭证
- **核心机制**：
  - 3 级管道：Manifest（schema）→ Functional（工具调用）→ Domain Expert（校准问题）
  - 6 轴加权：准确率 35% / 安全 20% / 可靠 15% / 过程质量 10% / 延迟 10% / schema 质量 10%
  - **共识评审**：2-3 个 LLM judge 并行 + 一致性阈值（省 50-66% 调用）
  - **5 种对抗探针**：提示注入 / PII 泄露 / 幻觉 / 溢出 / 系统提示词抽取
  - IRT 自适应测试（Rasch 1PL）+ OpenSkill 竞技场
- **与我们的关系**：能力测评（事前认证）vs 输出评分（事后评判）
- **可借鉴**：⭐⭐ **对抗探针**——我们完全没有「故意注入看评分器是否被带偏」的测试；**共识评审**——多 judge 并行（我们的升级是串行 K 次）
- **我们超越**：细粒度 logprobs · 运行时集成 · 证据链
- **局限性**：重系统（Docker）；面向 MCP 服务器认证，非 DSH 会话内评分

### 4.4 1549080929-debug/math_agent（VAL）

- **仓库**：https://github.com/1549080929-debug/math_agent
- **是什么**：提出**验证自主等级（VAL, L0–L5）**——给「验证方案」本身分级；核心理念「每一层都必须挂接可验证的裁判，裁判必须理解完备性而不只是正确性」；预印本 *Grading the Graders*（arXiv:2608.19009）
- **核心机制**：

  | 等级 | 锚定来源 | 保证 | 完备性 |
  |---|---|---|---|
  | L0 | LLM 自证（"我检查过了"）| 无 | 无 |
  | L1 | 题面/代码确定性规则 | 确定性匹配 | 无 |
  | L2 | 客观真值/oracle/金标 | 正确性 | 无（完备性盲区）|
  | L3 | 可判定系统（解集等价/类型/决策规则）| 单性质完备 | 有（ODD 内）|
  | L4 | 领域级证明系统（类型系统/证明内核）| 领域完备 | 有（域内）|
  | L5 | 通用完备验证 | 任意性质 | 不可判定（Rice 定理）|

  - 配套工具：val_standard.py（判级）/ val_raise.py（抬级处方）/ val_interrogate.py（追问层）
  - 元教训：「裁判的裁判也需要裁判」——验证器自身也要被校准/审计
- **与我们的关系**：**理念框架**——它不提供评分器，提供「如何评价你的评分器」的框架
- **可借鉴**：⭐⭐⭐ **VAL 标注**——我们的评分大部分是 L0-L1 级（LLM 判断 + clamp 规则），证据链是 L2（冒烟=客观真值）。方向：**面板标注验证自主等级**，扩展现有「logprobs vs literal-mc」标注成 VAL 级（这分是 LLM 说的 / 确定性规则 / 客观证据）
- **我们超越**：四轮 Best-of-N 审计本身就是「裁判的裁判」（与 VAL 理念同构，但无框架化）
- **局限性**：研究型仓库，无 DSH 集成；VAL 是诊断框架不是运行时评分器

---

## 5. 综合对比矩阵

| 项目 | 类别 | 评分方式 | 验证粒度 | 与 DSH 集成 | 可借鉴度 |
|---|---|---|---|---|---|
| **我们 dsh-verifier-brain** | 评分插件 | logprobs + literal-mc | 结果+轨迹+过程 | ✅ 原生 | — |
| uson1x/llm-verifier | 评分插件 | MC 采样（无 logprobs）| 结果 | ✅ 插件 | 已吸收 |
| DeepVerifier | 验证+反馈 | rubric 规则 | 结果+过程 | ❌ | ⭐⭐ rubric 反馈 |
| CompassVerifier | 专训验证器 | 专训模型 | 结果 | ❌ | ⭐⭐ 异常检测 |
| GenPRM | PRM | 专训 PRM + CoT + 代码验证 | 过程 | ❌ | ⭐⭐ 先推理再打分 |
| ThinkPRM | PRM | 专训长 CoT PRM | 过程 | ❌ | 印证专训方向 |
| Judge LLM | 评估框架 | 多种评估器 | 结果+轨迹 | ❌ | ⭐⭐ 成本跟踪 |
| Representation-as-a-Judge | 表示评判 | 小模型激活 + 分类器 | 结果 | ❌ | 观察 |
| attest | 事实核查 | 声明-证据对照 | 声明级 | ❌ | ⭐⭐⭐ 证据对照 |
| ai-validator | 行为验证 | 声明×工具调用对照 | 行为级 | ❌ | ⭐⭐ 行为核对 |
| Quality Oracle | 能力认证 | 挑战-响应 + 共识评审 | 能力级 | ❌ | ⭐⭐ 对抗探针 |
| math_agent (VAL) | 验证框架 | L0-L5 分级 | 元级 | ❌ | ⭐⭐⭐ VAL 标注 |

---

## 6. 借鉴优先级清单

| 优先级 | 借鉴点 | 来源 | 落地难度 | 说明 |
|---|---|---|---|---|
| **P1** | **声明-证据对照** | attest / ai-validator | 中 | bestofn 评分前把候选自述与冒烟证据逐条核对，抓「自述与证据矛盾」——我们已有证据链，只差「核对」这一步 |
| **P1** | **VAL 标注** | math_agent | 低 | 面板显示验证自主等级（LLM 判断/确定性规则/客观证据），扩展现有 logprobs-vs-literal-mc 标注 |
| P2 | **rubric 引导反馈** | DeepVerifier | 中 | compare/track 不只给分，给「分解后子问题级反馈」 |
| P2 | **对抗探针测试** | Quality Oracle | 低 | 给测试加「提示注入候选」看评分器是否被带偏 |
| P2 | **异常响应检测** | CompassVerifier | 中 | probe 加「响应形态检测」（过长/空洞/非结构化）|
| P3 | **先推理再打分** | GenPRM | 低 | 评分提示词显式加「分步推理」结构 |
| P3 | **成本跟踪** | Judge LLM | 中 | usage 升级为成本报告，激活 maxCostPerVerification 死配置 |
| 观察 | 表示级评判 | Representation-as-a-Judge | 高 | 需训练；等待 DSH 暴露激活能力 |
| 观察 | 专训验证器 | CompassVerifier/ThinkPRM | 高 | 需训练；与即插即用哲学冲突 |

---

## 7. 方向判断总结

1. **评分型 verifier 的工程实现，我们已是生态内最完整的**：logprobs 精确路径 + 采样降级 + 防线 + 面板 + 团队协议，四轮审计验证。uson1x 是最接近的同行，其精华已吸收。

2. **最大盲区是「事实核查」**：attest 引用的 *Gaming the Judge* 论文（重写推理不改事实，AI judge 误报率可升 90%）直击「LLM 评分型 verifier」的共性弱点。我们的 /bestofn 证据链（冒烟/截图/自述）已经是「receipts」，但只展示不核对——**声明-证据对照是最值得做的 P1**。

3. **可信度透明是差异化机会**：math_agent 的 VAL 框架给了「标注评分可信度等级」的现成语言；我们面板已有 logprobs/literal-mc 标注，扩展成「验证自主等级」成本低、价值高——用户能分辨「这分是 LLM 说的还是机器证实的」。

4. **专训验证器是长期方向但不是现在**：CompassVerifier/ThinkPRM 证明「专训小模型 > 通用 judge」，但我们零训练成本、即插即用的定位是差异化优势。等生态成熟再评估。

5. **PRM 的「先推理再打分」是低成本改进**：GenPRM 证明分步推理提升判断准确率，我们的评分提示词可显式化这一结构。

---

*整理：dsh-verifier-brain 开发会话 · 2026-08-23 · 基于各项目 README 实读（gh API）+ 本插件四轮 Best-of-N 审计结论*
