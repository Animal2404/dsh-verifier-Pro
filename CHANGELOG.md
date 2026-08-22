# CHANGELOG

语义化版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
