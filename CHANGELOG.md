# CHANGELOG

语义化版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased] — v0.5.0 之后（将并入 0.6.0）

### Added
- **P1-② VAL 验证锚定**：面板与 /bestofn 报告标注验证自主等级（L0 LLM 判断 / L1 规则介入 / L2 客观证据）
- **P1-① 声明-证据对照**：/bestofn 评分前把候选自述与冒烟证据机械核对，矛盾候选降信并显式警告
- **rubric 分解验证（decompose）**：轨迹摊开 → 失败分类（DeepVerifier 14 类）→ 核查问题；诚实适配（生成不实查）
- **evaluate_session**：轨迹评分结构化导出（checkpoint 表 + 趋势 + JSONL 就绪串）
- **响应文本检测**：INCOMPLETE/REPETITIVE/REFUSAL（CompassVerifier C 类）→ anomaly 警告
- **majority 短路**（后因概念误用移除——见 Removed）
- **面板逻辑抽离为可测模块**（panelLogic.ts）+ 9 用例 GUI 回归
- **文档五件套**：配置详解/真实性能基准/错误排查 FAQ/端到端示例/命名说明

### Changed
- **reason-first 评分**：评分提示词追加分步推理指令（启发自 CompassVerifier CV_COT，非 GenPRM 机制移植）
- **异常分数形态检测**：NaN/全 0.5/全挤极端 → anomaly（自研护栏，扩展 exact-flat）
- **CI 从空心升级为真测试**：~84 项（bridge 51 + 纯逻辑 30 + build_evidence 3），拆 core/bridge 双 job
- **测试导入守卫**：CI 测试的 lib/ import 必须落在独立编译清单内
- **CDP 冒烟加固**：会话点击三级容错（精确→前缀→虚拟滚动）
- **decompose/evaluate_session TS 层重试**（偶发空响应）
- **stable/0.5.x 稳定分支**建立；actions 升级 v7（清 Node 20 弃用警告）

### Removed
- **majority 短路**：误标借鉴 uson1x（其 majorityVoting 是采样级一致，我实现成候选文本级多数——概念错配 + 多数≠正确的正确性风险）。锦标赛永远裁决

### Fixed
- evaluate_session 导出表错位（官方 track 返回 checkpoint 分数 ≤ 步骤数，诚实标注）
- majority 短路曾伪造 outlier 质量分（0.000 = 假陈述）——移除
- VAL degraded 误标 L0（exact-flat 规则触发应为 L1）
- persist 轮转对齐 agent-teams 完整原子写（错误码白名单 + 退避 + 直接写回退）
- **decompose/evaluate_session 面板空白**（无 reward_a/b 也无 index+scores，卡片只显示徽章）→ 新增摘要行（🔬 轨迹步数/可疑行为/核查问题 · 📊 checkpoint/均分/趋势）
- **Semaphore.acquire 死 API 删除**（零调用方）
- **启动 probe 计费**：全 compare 改为 1-token 探测（成本可忽略）
- **smoke 外部 Chrome 重复注入**：连接级标志防累积
- **maxCostPerVerification 真实实现**：基于 history 真实耗时 × 费率估算，超预算拒绝（此前是无效预留配置）
- **statusWait 轮询**：确认内存优先（运行中任务不读盘），注释文档化
- **关键错误双语化**：probe 拒绝/成本拦截等常见错误附英文版
- README action 数 9→11；panelLogic ACTION_LABELS 补 decompose/evaluate_session
- RELEASING.md 新增发版前验证清单（#17）+ 同 commit 更新文档规则（#18）

## [0.5.0] - 2026-08-23

Best-of-N 三方审计（Round A/B）全部 P1 修复 + P2 批量清零 + Round C 复审计修复。

### Fixed（Round C 审计批次）
- **R3-1** 凭据解析：provider 节子键需匹配 key/token/secret 才映射（base_url 不再覆盖 API key）；顶层键复位 section（跨节污染消除）
- **F3-TS** 坏帧关联正则兼容字符串 id（原为死代码），且仅 `{` 开头行才尝试关联（不误伤日志）
- **R3-2** select unstable 分支 clamp 提前——越界分不再泄漏到模型上下文/面板
- **R3-3/R3-4/R3-5** F15 上限与 sanitize 下沉 runner fall-through + 同步 track/progress；progress_* 纳入共享并发闸门
- **R3-6** parseCriteria 权重校验不再被 JSON.parse 的 catch 吞掉（README「报错拒绝」契约兑现）
- **R3-7** service.progressStart 注入 defaultModel；**R3-8** clamp01(null)→NaN（被洗白的 NaN 不再变确定 0 分）
- **R3-9/R3-10** smoke 静态页真正截图；ERR 采集器会话级注入一次（消除 k× 错误膨胀）
- **R3-11** /bestofn 冠军索引非法时显式报错（不再打印 undefined 冠军）
- **R3-12** 分级评分 history 记实际升级模型（成功路径）
- **R3-14** 升级轮始终使用独立缓存文件（消除 rep-0 命中 k1 导致的权重偏置）
- **R3-15** probe 对 tie 形 0.5/0.5 判不支持（不再误报 logprobs 可用）
- **R3-16** done 记录保留原始 params（duration_ms 独立字段）
- **R3-17** statusWait 响应 AbortSignal（取消不再空转 300s）
- **R3-18** 轮转原子写（tmp+rename）
- **R3-19** build_evidence 直喂 .smoke.json 时从 `file` 字段派生哈希名；service select/compare 强制 criteria（对齐 U-N1）；README engines/action 计数/模型推荐修正；版本号 0.5.0
- 提示词：tie-handling 协议显式化（select flat 且 compare 复核仍在噪声带 → 不发明冠军、全量合并）

### Fixed（Round A/B 批次）
- **F1** 升级评分全链路 clamp01：升级轮越界分逐轮裁剪，anomaly/warning 透传到 composite 与面板（此前仅首评设防）
- **F2** SECURITY.md 虚假声明纠正：sanitizeForVerifier 从未存在 → 真实实现传输层消毒器（10k 截断 + 控制符剥离 + 注入短语中性化）并接入 compare/select 入参
- **F3** NaN/Infinity 不再打穿 stdio JSON-Lines 协议：`_jsonable` 洗非有限浮点 + `allow_nan=False` 兜底 + TS 侧坏帧按 id 关联立即 reject（此前请求假死到全额超时）
- **F4** images 双洞：compare 缓存键补 images；select 补 images 透传 + 缓存键
- **F5** AbortSignal 监听器泄漏：bridge.ts 统一 cleanup，所有 settle 路径（成功/超时/中止/写败/坏帧）摘除监听
- **F6** 并发闸门收口：共享 Semaphore 贯通工具 / 异步任务 / bestofn / 服务缝四条路径
- **U-B1** escalationModel 接回同步工具路径——分级评分对最常用路径生效
- **U-N1** task_start 加固：method 白名单、params 必须为对象、select/compare 强制显式 criteria（堵桥层静默 DEFAULT_CRITERIA 替换）
- **U-N2/U-N9** 服务缝 ctx.verifierBrain.* 改走升级 runner：缓存/clamp/闸门/history/defaultModel 注入与工具路径完全一致
- 安装三连：README 包名大写 Pro→pro（装配失败根因）、示例模型 flash→v4-pro、Node 门槛三处统一 >=18
- **凭据解析加固（U-B4/U-N11/U-N7）**：env-only OPENCODE_GO_API_KEY 无凭据文件也生效；嵌套 provider 节（deepseek: + api_key:）运行时与 setup.mjs 同表映射；行内注释引号感知剥离 + 引号值反转义
- F7 probe 错误分类改 fail-closed（401/402/网络故障不再被误报为健康）
- F8 setup --fix 原子写（tmp+rename）+ 缺行自动插入 + .bak 只留 3 份
- F9 Windows 下超时不再漏标（布尔标志替代 signal 检测）
- F10 同名候选冒烟产物哈希后缀防互相覆盖
- F11 冷恢复垫片：重启后 running 任务标记 interrupted，任务 id 序号跨重启续接；内存任务表封顶 200
- F12 select 临时缓存文件 finally 必清（%TEMP% 不再每次调用遗留孤儿文件）
- F13 compare 首个升级 rep 失败降级保留 k1（与 select 行为一致）
- F15 n_evaluations≤8 / pivots≤20 / max_workers≤16 硬上限（成本爆炸向量封口）
- F16 bestofn --summary 带空格解析修复；团队规模 N 封顶 8
- F17 check_client.mjs 真正接进 build.sh；过期注释修正
- U-B2/B3 unstable 与预算跳过路径补 history 落盘（成本审计不再缺数）
- U-N4 track checkpoint_steps 校验 + 过并发闸
- U-N5 bestofn 激活指令 evidence_chain 改绝对路径（含系统提示词同步修正）
- U-N14 smoke 记录缺失从"默认幸存"改"unknown 排除出排名"
- U-B5/B6 验收/测试脚本废弃 flash 全部换 v4-pro；test_bestofn Python 路径跨平台
- U-I7 peerDeps 补 @deepseek-ai/dsh-client-ui-tool
- U-B17 双编码 mojibake 文件头修复
- U-B15 README 不再宣称 maxCostPerVerification 已生效（v0.6.0 待办）

### Added
- CI：GitHub Actions（build + typecheck host/client + 离线单测）
- 凭据解析离线单测 8 条（三种布局 + 别名优先级矩阵）；升级链路回归测试 5 条（clamp/anomaly/分级路由/降级）
- history.jsonl 自动轮转（超 2000 行裁到最近 1000）

## [0.4.9] - 2026-08-23

### Changed
- 说明卡文字中性化（与卡片同色深底 + 中性灰文字）；最优方案恢复绿色加粗 🏆（用户最终配色定版：彩色仅徽章 + 最优行）

## [0.4.8] - 2026-08-23

### Changed
- 面板视觉三改：说明卡与卡片同色深底（去黄/灰差异底）；候选改 A/B/C/D 字母标；彩色只保留右上角徽章（赢家加粗+🏆）
- CDP 探测选择器适配中文卡片标题；截图脚本增加 console/异常捕获

## [0.4.7] - 2026-08-23

### Added
- 统一白话说明系统：每种非绿色徽章（出错/信号不可信/无区分度/信号不稳/分差小）都自动带说明卡，宿主 warning/message 作为虚线分隔的第二行小字

## [0.4.6] - 2026-08-23

### Changed
- 面板"自适应升级"文案去黑话：徽章 `已升级复核×N` → **`分差小 · 已评N次`**；分数下方新增大白话说明行（"两个方案得分接近，单次评分可能有偶然性——已自动独立评审 N 次并取平均（每次交换先后顺序），结果更可靠"），layer-2 底色便签样式

## [0.4.5] - 2026-08-22

### Added
- 面板中文化：动作名中文为主、英文枚举保留为灰色小字后缀（择优评选·select / 对比评审·compare / 轨迹打分·track / 进度追踪·* / 异步任务·* / 用量统计）；状态徽章中文化（正常 / 信号不可信 / 无区分度 / 信号不稳 / 出错）；候选行改为 方案A/方案B/方案N 🏆最优

## [0.4.4] - 2026-08-22

### Added
- **Web 面板端到端点亮**（真实浏览器截图验证）：keyed `tool.call.toolview` 客户端卡片按官方 `ToolCallOwnerProps` 平铺契约读取数据；host 经官方 `output.presentationMeta` 通道把评分结构投递到 `block.meta`；徽章随信号变色（ok/degraded/flat/unstable/escalated），select 显示候选分数条+🏆，compare 显示 A/B 对比，警告框独立样式
- 主题适配：全套宿主设计令牌——颜色 `--dsw-alias-*`、字体 `--dsw-font-family`/`--dsw-font-markdown-code-block-*` 度量体系，深浅主题自动跟随，零硬编码色值
- 工程化：tsdown 产物改为 CJS + ModuleLoader 包装（`scripts/wrap_client.mjs` 幂等包裹）+ `check_client.mjs` 语法/特征校验；build.sh 链接 dsh-client-ui-tool/client-runtime 类型
- 测试工具：`scripts/cdp_web_screenshot.mjs` —— CDP 驱动无头浏览器进会话、探测 verifier 卡片数、React fiber 内省 block 结构、截图（面板回归可机器实测）

### Fixed
- 凭据优先级（401 根因）：持有原生供应商凭据时不再让 OpenCode 别名回退覆盖 OPENAI_API_KEY；配置显式指定 backendBaseUrl 命中某代理时，该代理凭据优先于通用回退
- 后端切换（402 处置）：DeepSeek 官方账户余额不足 → 默认后端切回实测可用的 opencode deepseek-v4-pro
- client bundle 形态：tsdown 输出从嵌套 ESM 目录修正为扁平 `lib/client.js` CJS + ModuleLoader 外壳（此前热重载预检三次拦截的根因）
- 面板 props 契约：v2 的嵌套 `{owner}` 解构在渲染期抛异常致整卡被错误边界吞掉 → 改为平铺字段 + 入口守卫（任何怪数据都不再抛）

## [0.4.3] - 2026-08-22

### Added
- Client 侧工程化：`src/client/index.tsx`（VerifierPanel + SettingsPanel）、`tsconfig.client.json`、`tsdown.config.ts`；`cordis.patch.yml` 增加 client 注入；`build.sh` 集成 tsdown 与 `@deepseek-ai/dsh-commands` 链接；package.json 声明 `exports["./client"]`、`dsh.client`、react/react-dom/client-runtime peer 依赖
- 并发加固（P0-3）：零依赖 `Semaphore` 限流桥评分调用（`maxConcurrentScoring`，默认对齐 maxWorkers=4）；`LRUCache`（500 条 / 30min TTL）替换无界结果缓存 Map，消除长会话内存泄漏与陈旧缓存
- 子进程生命周期（P0-4）：evidence_chain spawn 加 10 分钟硬超时，SIGTERM→5s 后 SIGKILL 升级，超时退出码 124 并在输出中标注
- 安全边界（P0-5）：compare/select 返回分数 clamp 到 [0,1]，越界时输出 `anomaly: reward_out_of_range/score_out_of_range` 标记并附原始值人工复核警告
- 测试基线（P0-6）：`tests/concurrency.test.mjs` 11 用例（node:test 零依赖），npm scripts 新增 `test` 与 `verify`
- 文档体系（P0-7）：docs/PROGRESS.md、重写编码损坏的 PLAN.md 与 ROADMAP.md、SECURITY.md
- setup.mjs --fix 自动写入推荐 verifierModel/backendBaseUrl 到 cordis.patch.yml（时间戳备份原文件）
- bridge probe 动作：启动探测 logprobs 支持性、模型、base_url，不支持时告警
- verifier 工具新增 `usage` action（token 计量透传）与 AbortSignal 全链路透传

### Changed
- README：诚实标注 Best-of-N 合并边界（仅单文件文本层验证，默认关闭）；新增版本钉扎指引、criteria 权重校验说明、新配置项文档
- cordis.patch.yml 默认后端切换 deepseek-chat @ api.deepseek.com（凭据感知推荐）
- tsconfig.json exclude src/client（client 由 tsdown 独立构建）

### Security
- git 历史泄露 API key 清除（git filter-repo 重写 + 强制推送 + key 轮换）

## [0.4.2] - 2026-08-22

### Fixed
- opencode DFLASH 投机解码致 deepseek-v4-flash logprob 全灭 → 切换实测可用模型矩阵并在 README 标注
- npm 包名大写被 registry 拒收 → 全小写化
- score cache 跨任务投毒 → 每次调用独立临时 cache 文件（作用域隔离优于 HMAC 签名，成本更低）

### Added
- 自适应 K 升级（分差落噪声带自动 K=3 重评，槽位交替消位置偏差，方向不一致如实上报 unstable）
- exact-flat/degraded 护栏（全 0.5 = 批量失败被 tie 掩蔽的特征签名）
- probe_logprobs.py / scan_logprob_models.py 后端诊断脚本
