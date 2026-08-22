# CHANGELOG

语义化版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
