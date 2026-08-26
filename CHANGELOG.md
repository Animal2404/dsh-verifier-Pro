# CHANGELOG

语义化版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.7.4] - 2026-08-26（bestofn-refcomp 终版合并报告修复批）

### Fixed

- **F1（fatal）**：task_start(track) 整链绕过运输层加固——异步任务执行器只把 select/compare 交给 runner，track 直达裸桥请求（无 sanitize / n_evaluations 上界 / costGuard / scoringGate / clamp01）。现在 task_start 全部方法收口到同一 runner，fall-through 分支补 U-N4 checkpoint_steps 校验
- **F2**：literal-mc 部分丢标签静默折算 0.5 混入均值——新增逐请求事件：单侧标签缺失计入窗口计数，桥在结果上挂「已按字面回退 0.5 计入」告警；降级自愈语义不变
- **F3（MAJOR）**：响应形态异常检测存 thread-local，官方内层线程池写入、处理器线程读取恒为 None（主力路径死代码）——改为进程级有界事件表 + t0 窗口化 drain，select/多 job compare 上真正生效
- **F4（MAJOR)**：maxWorkers 只限桥请求层，官方内层 fan-out 缺省走 50/500 路——四个评分 handler 现将 max_workers 缺省钳制到桥 worker 数（显式传参仍可覆盖）
- **F5**：ProgressTracker TTL 按创建时间计杀活跃 tracker → 改最近访问滚动
- **F6**：track 全 0.5 形态护栏——官方对不可读 checkpoint 静默记 0.5，桥侧统一打 anomaly/warning（同步/异步/服务缝一次覆盖）
- **F7**：flat 分支渲染双 ⚠️ → 走幂等 warnText
- **F8**：compare/select unstable 返回补 duration_ms
- **F9**：evaluate_session 导出表 checkpoint 序号错位 → 桥透传官方 ProgressResult.steps，导出用真实步号
- **F11**：升级 reps 不参与缓存去重（并发同参双烧）→ compare 升级轮与 select 整场升级锦标赛进 in-flight 缓存
- **F12**：compare exact-flat 告警错误归因 on_error="tie"（官方 compare 无此参数）→ 改为 extract_score 字面回退真机制
- **F13**：JSONL 轮换 rename 重试忙等阻塞宿主事件循环 → 直接落内容等价 direct write 回退
- F10 探测预检不对称【交叉互评降级存疑】：不修（建议修法破坏 fail-closed 自愈）

### Added（能力缺口 G1-G5）

- **G1** 判别力自检基准：scripts/discriminative_check.py 固定微任务集 A/B 对照（粗判别/细判别/中文/跑题），setup.mjs --bench 一键接入——换评分模型后的质量回归门
- **G2** 真实 token 计量回填 costGuard：gatedRequest 前后读 usage 差值进按 kind 的 EMA，估算优先实测、时长粗估兜底取较大值
- **G3** criteria .md 模板库热加载：criteria/ 目录（TEMPLATE + deep_review/root_cause 目录版优先于内置），每次评分读盘即生效，名字白名单防路径穿越
- **G5** verifier config 只读回显 action：生效配置 + 修改位置提示（不做设置页，配置单源化是刻意取舍）
- setup.mjs --strict（CI 预检 exit 1）/ --profile / --no-mount / --bench 旗标；退出码新增 15=构建失败

### Verified（实弹）

- **G1 判别力基准 4/4 通过**（flash-vision-exp @ opencode，四任务 margin +1.000/+0.106/+0.991/+1.000）；脚本首跑全 0.5 暴露直调官方 API 未打标 client 的坑——已在脚本内对齐桥的 `_llm_verifier_deepseek` 打标 + bridge_fix.install()
- **G4 多模态 images 首次真实验证通过**：红/蓝方块带图 select 正确择红（index=0，0.654/0.346）
- 附带修复：README probe_logprobs.py 参数顺序文档反了（实际签名 base_url api_key model）

### Installer（安装体验 fatal×2 + MAJOR×5）

- **F-1**：「一键安装」跑完并未安装插件 → --fix 六步闭环（venv→pip→复核→双写推荐配置→构建→挂载 profile），README 同节重写
- **F-2**：端到端示例硬编码作者本地目录 + 三份 cordis.patch.yml 生效关系未定义 → 示例去硬编码、--fix 双写仓库+profile 补丁、三层关系图入档
- **M-1**：默认后端=作者私有凭据环境 → 插件启动检测无凭据时打响亮告警指向 setup.mjs
- **M-5**：宣称 Windows 一等公民但构建硬依赖 bash → npm run build 改纯 Node 入口 scripts/build.mjs（build.sh 保留）
- **M-6**：凭据→backendBaseUrl 解析零文档 → README 新增绑定表与优先级规则
- M-4【交叉互评降级为文档缺口】→ README 新增「卸载与残留清理」表（含 stateDir 敏感数据提示）
- m-1 Python 口径对齐 3.10 · m-2 deepseek-chat 行诚实标注 · m-3 cordis.patch.yml literal-mc 注释矛盾修正 · m-4 llm-verifier 加 <0.3.0 上界钉扎 · m-5 ZH 示例配置块补全 · m-9 merged-setup.mjs 残留改名 · m-10 --check 恒 0 限制以 --strict 收口

### Docs

- M-2/M-3：README.en.md 与 ZH 对齐（补齐手动安装/配置详解/FAQ/命名/端到端/criteria/升级卸载节，action 数 8→12）；ZH 新增升级与卸载节、钉扎示例动态措辞；ci.yml 兑现 workflow_dispatch；PROGRESS.md 版本漂移追平（v0.7.1-v0.7.4）
- 打包修正：npm files 白名单补 `criteria/`（G3 模板目录）、`scripts/discriminative_check.py`（G1 基准，--bench 依赖）、`scripts/build.mjs`（M-5 纯 Node 构建入口）——此前均不会进 tgz
- 本地工程记忆归档：12 份历史开发文档合并为 docs/HISTORY.md（沿用 docs/* 的 .gitignore 排除策略，不入公开仓库）；PLAN/README/acceptance 脚本的引用同步改指归档

## [0.7.3] - 2026-08-26（外部评审 4 个确认 bug + 逻辑问题修复）

### Fixed（外部评审报告 AUDIT-2026-08-26，全部经逐条源码核验后修复）

- **#1（BUG）**：bestofn 输出目录清理正则永不匹配——生成名带毫秒+`Z` 尾巴（`...T09-15-30-123Z`），清理要求秒后直接结束 → B13 清理是死代码，每个 `/bestofn --local` 永久留目录。正则改为容忍 `-\d{3}Z` 后缀
- **#2（BUG）**：costGuard 语义与文档相反 + 永久锁死——旧实现按「最近 20 条累计 + 本次」拦截，攒满窗口必超小额预算 → 之后全部被拒；且被拒不落 history → 窗口冻结只能手删解锁。改回文档语义「单次验证最大成本」（仅按本次估算判断）
- **#3（BUG）**：服务缝绕过数值 criteria 拒绝——`parseCriteria` 只在同步字符串路径拦，服务缝传对象原样透传 → 官方包把 0.5 字符串化成无意义描述。拒绝移入 `expandCriteria`（runSelect/runCompare 唯一收口）
- **#4（BUG）**：未知模型探测结论与评分路由互相矛盾 + probe 无缓存——probe 动态判定 literal-mc 但 router 只查静态表 → 白烧探测费后照样挂；表外标签探测是 4096+ token 真实计费调用且每次重探。修复：probe 结论记入进程内集合（router 走 literal-mc）+ probe 结果 TTL 缓存（5min）
- **#5**：history 被 cache 命中污染（~1ms 记录拖垮中位数 → 成本/水位系统性低估）→ costGuard 与 estimateCallMs 过滤 `cached !== true`
- **#7**：`degenerate_extreme` 误伤真实共识（双优 0.97/0.96 也被打退化警告）→ 加区分度条件（极差 <0.02 才告警）
- **#8**：ProgressTracker 只增不减（agent 忘 close 随桥进程寿命泄漏）→ 新建时 TTL 淘汰超 1 小时的 tracker
- **#12**：`npm test` 的 glob 在 cmd 不展开、Node<21 报找不到模块 → 实测各形态后保留 node 自展开 glob（Node21+ 由 --test 自行展开，任意 shell 可用；Node18/20 为 EOL 不再适配）
- 新增回归测试：全挤极端无区分度告警 / 双优有区分度不误报 —— 测试 **94/94** 全绿

### 已知限制（记录不修）
- #6 select 升级 k_used 叙述与平均权重不符（行为正确，如实标注即可）；#9 decompose 不进 history/costGuard（改动面大）；#10 unstable 分支缺 duration_ms 等观感项；#11 MODEL_PROFILES 硬编码快照的移植性（结构性）；#13 sanitize 截断对调用方不可见；#14 启动探测失败永不重试

## [0.7.2] - 2026-08-25（R3 vselftest 审计修复：双成员 43 项发现）

### Fixed（/vselftest AUDIT TRACK 双透镜审计，队长机械核验全部引用；B3 判假剔除、m1 降级 info）

- **S2/M2（MAJOR）**：页面 state 含循环引用/BigInt 时页内序列化抛错 → 合法候选被误判 crashed —— 探针改为整体序列化失败时降级为「丢弃 state 保留行为证据」（`stateOmitted` 透出）
- **S4/M1（MAJOR）**：Node 冒烟超时只杀直接子进程 + SIGTERM 陷阱候选挂死 —— SIGKILL 升级 + 硬回退 resolve（永不再挂到外层 10min）
- **m2（MINOR）**：CDP `{id,error}` 错误形此前走 resolve 静默滑过（Page.navigate 失败仍在旧页面探针）→ 改为 reject，错误可见且逐文件崩溃记录
- **S1（MINOR）**：frameId 跨同 tab 导航复用，M2 隔离前提不成立 —— 改为 context 代数归属（导航前 context 集合剔除旧文档迟到异常）
- **S11/m8（MINOR）**：file URL 未百分号编码（空格/#/? 路径加载错误文件）→ 逐段 encodeURIComponent
- **m3（MINOR）**：F-H 只剥带前缀首行，多行 stdoutTail 续行「错误:」仍伪造矛盾 —— build_evidence 尾部换行转义为 ⏎（整条单行可完整剔除）
- **B1（MAJOR）**：目标尾部数字 1-8 被静默吞为 N（goal 截断）—— nSource 追踪，team 消息显式告警「尾部数字已作为 N」
- **B2（MAJOR）**：打错文件名守卫需 ≥2 已存在文件，「2 文件错 1」仍翻转团队 —— 放宽为 ≥1 已存在
- **B4（MAJOR）**：证据链超时杀但部分 evidence 存在 → 部分集当完整集 —— chainNote 显式标注「证据链未完整完成」
- **B5（MAJOR）**：vselftest 激活指令硬编码 `E:\DeepSeek` 绝对路径 → 从 pluginRoot 派生
- **B6（MINOR）**：unknown 候选多为 artifactName↔smokeRecord 契约漂移信号 → 报告显式告警
- **B7/m11（MINOR）**：损坏 smoke.json 静默当 missing → stderr 诊断
- **B8（MINOR）**：负面词正则误伤诚实自述（「未实现 X」）→ 收窄为整体否定形态
- **B10/m10（MINOR）**：`/bestofn a.html b.html 5` 静默吞 N / `/bestofn a.html 5` 翻转团队 → parseArgs 拒绝吞「其余全像文件」的尾数 + handler 救援扩展
- **B11（MINOR）**：`-n 0x10`/`-n 1e2` 被接受 → 仅十进制数字
- **B12（MINOR）**：`--summary a=README.md` 首 token 文件形被拒 → 首 token 不按文件形中断
- **B13（MINOR）**：bestofn/ 输出目录只增不减 → 保留最近 20 个清理
- **B14（MINOR）**：「排名」按输入序非分数序 → 按分数降序展示
- **B15（MINOR）**：团队模式静默丢弃 --summary/--quick → 透传给队长激活指令
- **B18（MINOR）**：「冒烟=客观真值 L2」表述过强 → 限定「确认未崩溃，行为正确性未证明」
- **B20（MINOR）**：单文件 `/bestofn a.html` → 团队 goal「a.html」→ 显式报错
- **m4（MINOR）**：写盘失败中止整轮、node/html 症状不一致 → safeWrite 容错
- **m5（MINOR）**：`--cdp-port abc`→NaN 端口；`--ticks 1e9`→浏览器长循环假 crashed → 端口校验 + ticks 封顶 10000
- **m7（MINOR）**：重复候选不去重 → 本地模式 Set 去重
- **S5（MINOR）**：复用外部 Chrome 导航用户第一个 tab → 新建独立 tab（/json/new）用完即关
- **S6（MINOR）**：同 --out 并发实例证据互污染 → 排他锁文件
- **S10（MINOR）**：截图失败仍 ok:true 且 note 宣称「已截图」→ 如实标注证据缺口
- **S13（MINOR）**：stdout/stderr 无上限累积 → 64KB 滑动截断
- **S14（MINOR）**：信号杀死 code=null 报「exit code null」→ 明确措辞
- **S17（MINOR）**：自拉 Chrome 无 --user-data-dir → 临时 profile 避免与用户 Chrome 锁冲突
- **S19（MINOR）**：artifactName 哈希 8→12 hex（32bit 碰撞）——smoke.mjs / build_evidence.mjs / 契约①/D-1 测试同步
- **S20（MINOR）**：`/json` 探测无超时 → AbortSignal.timeout(3000)
- **S23（MINOR）**：N10 的 `parsed?.error` 死条款移除（CDP 错误形状无 error 属性）
- **S3（MAJOR 补修）**：rAF 自驱动页面双重驱动 + 时间压缩（dt≈0 假 NaN）→ ERR_COLLECTOR 注入 rAF 计数器（早于页面脚本），探针检测到自驱动即跳过手动 tick（`selfDriven` 透出到冒烟记录）
- **S7（MAJOR 补修）**：采集器依赖页面可见全局（对抗候选 `window.__errs=[]` 可隐身）→ `Object.defineProperty` 非可写/不可配置，页面赋值静默失效，隐藏错误照常捕获（e2e 实测：对抗页抛错 → ok:false ✓）
- **S9（MINOR 补修）**：固定 1500ms 等待，慢加载页未就绪即 probe-skip → 就绪轮询（3×500ms）
- **S16（MINOR 补修）**：Node 候选并行执行（固定端口互抢假 crashed）→ 串行
- **S18（MINOR 补修）**：目录展开仅一层 + 自冒烟风险 → 递归（深度≤3、≤200 文件、跳过 node_modules/.git）
- **S21（MINOR 补修）**：重复 valued flag 静默首个胜出 → 显式告警
- **S22（MINOR 补修）**：`--` 开头文件名无法冒烟 → 支持 `--` 分隔符（其后一律视为输入）；findArg 仅扫描选项区
- **B16（MINOR 补修）**：runEvidenceChain 的 resolve() 与注释错位 → 注释修正（防御性 no-op）
- **B17（MINOR 补修）**：超长 --summary 撞 Windows argv 上限 → >6000 字符落临时文件 + `@file:` 前缀（build_evidence 解引用）
- 新增 10 条回归测试（B1/B8/B10/B11/B12/m3/m10/nSource）——测试 93/93 全绿

### 记录
- m9 结论：段头锚点保持字面全称，格式漂移由契约③ 测试守护（CI 断言两侧同字面）；不引入模糊容忍（容忍会把冒烟捕获组移位静默破坏核对——修复过程中实际踩到并回滚）
- 双成员交叉审阅：path-tracer 对 B2 的否决因算术错误无效（B2 成立）；defect-hunter 对 m1 判假成立（路径不可达，理由表述有瑕疵）；B3 三方一致判假
- 终评：verifier select("root_cause") unstable → compare 复核 A(攻击透镜) 0.973 vs B(逐路径) 0.818，A 胜出；B 的独有路径级发现（m2/m3/m4/m5/m7/m10）已并入本批修复

## [0.7.1] - 2026-08-25（R2 审计 15 条发现全部修复）

### Fixed
- **F-A/N1（MAJOR）**：目录展开白名单与 smoke 对齐——`evidence_chain.mjs` SMOKABLE 含 `.htm` 而 `smoke.mjs` collectFiles 不含（DH-F1「白名单一致」不成立，`.htm` 目录候选铸幽灵证据块）；collectFiles 补 `.htm`
- **F-D（MAJOR）**：CDP `send()` 不再永久挂起——每个请求带 30s 超时（与 Node 路径同语义），连接断开（onclose/onerror）时全部 pending 拒绝；HTML 冒烟逐文件 try/catch，单个候选失败产出 crashed 记录而非整 run 崩溃
- **N10（MAJOR）**：渲染进程崩溃不再假 PASS——`Runtime.evaluate` 返回不可解析结果（`parsed.raw`）时显式 `ok:false`，不再落进「静态页无错误 → ok:true」分支
- **N2（MAJOR）**：证据文本三态渲染——`build_evidence.mjs` 对 `kind=unsupported` 渲染「⏭️ 类型不支持（未执行，非崩溃）」并保留说明，不再谎报「❌ 失败」；bestofn 报告侧 `smokeState` 区分 unsupported/missing/unknown（F-G）
- **F-C/N3（MAJOR）**：不再静默翻转 team 模式——`/bestofn a.html b.html 9`（尾部数字 >8）前序全为已存在文件时按本地对比处理并告警；多个已存在文件 + 缺失项形似路径时直接报错（打错文件名守卫）
- **F-E（MINOR）**：导航失败检测——`Page.navigate` 返回 `errorText` 时显式 `ok:false`（此前不可加载页面被误报通过）
- **N5（MINOR）**：frameId 归属改 fail-closed——frameId 未知的异常不再记到当前候选头上
- **F-B（MINOR）**：显式 `--local` 下纯数字候选直接拒绝（此前生成幻影候选 `"9"`）；候选文件不存在时报错而非裸奔进证据链
- **N4（MINOR）**：`-n` 必须是正整数——`-n 0.5` 不再 `Math.floor → 0`（"spawn exactly 0 members"）
- **F-F/N6（MINOR）**：`--summary` 值在「形似文件路径」的 token 处停止——置于文件前不再吞掉后续候选
- **N7（MINOR, REPORTED→FIXED）**：相对路径锚定会话工作区（`invocation.agent.session.header.cwd`），不再锚定 host 进程 cwd
- **N8（MINOR）**：三个 CLI（smoke/build_evidence/evidence_chain/describe_visual）的 findArg 不再把 flag 形 token 当值吞掉
- **F-H（TRIVIAL）**：声明-证据对照扫描剔除 `stdout/stderr(尾):` 原始行——日志文本含「错误:/❌」不再伪造矛盾
- **F-I（TRIVIAL）**：`--summary` 值 trim 前导空格
- **N9（INFO）**：重复 `--summary key` 覆盖时告警
- 新增回归测试 `tests/r2-fix-regression.test.mjs`（12 条：parseArgs N4/N6/F-I/N9/N3/F-B + crossCheck F-H）

## [0.7.0] - 2026-08-24（第二轮深度审计修复 + 协议升级）

### Added
- **深度导向 criteria 预设**：内置 `deep_review`（根因+证据/失败模式/权衡/可执行性）与 `root_cause`——措辞为**探究式强制点名**：「指出至少一个非显然边界案例及处理方式」「引用可复制的证据行」，空泛断言（"已考虑边界情况"/"权衡过"）明确判低。通用 Correctness/Completeness/Clarity 三件套奖励广度、惩罚洞察，是「team 分析全面但浮于表面」的结构性对策。在 runSelect/runCompare 单一收口展开：同步工具 / 异步 task_start / 服务缝 / /bestofn 全路径可用；未知预设名原样透传（官方 terminal_bench 等不受影响）
- **协议升级（PLAN GATE + REVISION LOOP + 对抗性提问）**：
  - **计划门禁**——/bestofn 协议与系统提示词新增：派发完整实现前先收集各成员简案 → `verifier compare(criteria:"deep_review")` 选优 → 败方方案优点并入胜方再派发（砍错方向是最便宜的修复）
  - **修订环**——verifier/decompose 检出的失败归因与核查问题必须**原样派回**责任成员带证据解决 → 重跑证据链 → 复评；上限 2 轮防成本失控。验证不闭环 = 昂贵的橡皮图章
  - **对抗性提问闭环**——decompose 核查问题 → 成员逐条带证据回答 → Q&A 追加进候选证据文本 → 复评；回避/绕圈式回答本身就是出局信号
  - **深度纪律条款**——浅而全的候选必须输给深而准；rubric 表达不了这一点就是 rubric 的 bug
- **团队协作升级（吸收同赛道项目评审意见，加约束版）**：**透镜分化**——相同提示词的 LLM 成员产出会趋同；队长应给每个成员分配不同「透镜」（最大胆设计 / 最防御设计 / 性能与边界案例），但任务范围必须完整且一致——拆分范围=任务分解=排名失效；**相互审阅轮**（仅高风险目标）——初稿后每人指出另一成员产物最致命的一个缺陷（带证据），批评意见作为额外证据块进入 select
- **双轨协议（BUILD / AUDIT）**：/bestofn 按交付物类型分轨。起因：smoke 链的 kindOf 把一切非 HTML 文件当 Node 脚本执行——.md 审计报告会 SyntaxError → ok=false → 被当崩溃候选淘汰，**审计类任务此前根本无法用 /bestofn 跑**。审计轨改为「引用核验」：每条发现必须引用 file:line + 原文片段，队长机械抽查 ≥30% 引用 + 全部致命发现（grep/read），伪造引用即无效并减半该成员合并权重；范围冻结 + 反污染（审本项目禁止读历史审计文档防抄答案）；评分自动切换 root_cause 预设；最终报告逐条标注 VERIFIED/REPORTED。另加**预算门禁**：开跑前必须声明 N 与成本上限，无预算不开跑
- 新协议文本本身经 **verifier select("deep_review") 三方案评选 + compare 升级复核（K=3 一致 3/3）** 产生——工具用自己的教条改造自己
- **稳定候选标签（用户反馈：连续评选时字母换指代）**：select 结果带 `tags`、compare 带 `tag_a/tag_b`——候选文本 sha256 前 8 位，同一候选在任何一轮评估中标签不变；文本渲染与面板同步显示「A·3f2a1b9c」，跨轮拼子集按标签即可对回原始身份
- **`/vselftest` 一键自检命令**：对插件自身 bestofn↔smoke 协作边界发起 AUDIT 轨团队审计（范围冻结 + 反污染 + 引用核验 + 交叉审阅），零参数开跑
- **/vselftest 首轮实战修复（双成员审计 → 引用核验 0 伪造 → 交叉审阅纠偏 → root_cause 终评）**：
  - ★ **smoke.mjs `let state` 自遮蔽**——冒烟记录 state 字段恒 null（双方独立确认的新 bug，一行修复）
  - ★ **ERR_COLLECTOR 浏览器侧幂等守卫**——外部 Chrome 复用时 k 份采集器致错误 k× 计数（R3-10 只防了运行内累积），健康候选曾被误杀
  - **CDP 异常按 frameId 归属**——上一候选的迟到异常不再记到下一候选头上（"误判 crashed"根除）
  - **目录输入三重修复**——bestofn 本地模式显式拒绝并给展开指引；evidence_chain 展开目录后再喂 build_evidence（幽灵块根除）；四进程 cwd 钉扎插件根 + 输入绝对化（身份与继承巧合解耦）
  - **--summary 解析收口**——裸 summary / 空名 `=text` 拒收 + 无条件消费值 token（不再漏回参数流翻转 local⇒team；build_evidence 消费端同步守卫）
  - **-n 条件前进**——无效值不再吞掉紧随的候选文件，stderr 告警；N 截断透明化提示
  - **unsupported 类别**——.md/.txt 等不可运行文件标 ⏭️ 跳过而非 "exit code 1" 误导性 crashed（不计失败退出码）
  - **bare catch 诊断化**——evidence.json/smoke.json 解析失败写 stderr，损坏不再伪装缺失
  - --ticks/--wait 值位垃圾消毒；探测 WebSocket 用完即关
  - **契约钉扎测试**（tests/audit-contract.test.mjs）——artifactName 双实现哈希宽度/stem 规则、段落标题锚点、采集器幂等守卫，任一分叉 CI 即红

### Fixed
- **P1-① 成本预算覆盖不全**：`maxCostPerVerification` 守卫从工具 handler 下沉到 `runSelect`/`runCompare`/track 入口——此前只拦同步 select/compare，异步 task_start、服务缝、/bestofn 路径可无上限花钱；现全路径生效（tools.ts costGuard + EscalationDeps 挂成本配置）
- **P1-② compare flat 分支覆盖异常警告**：flat 结果不再用通用文案替换 k1 的越界裁剪警告——现在与 select 分支一致地合并（`警告 且：无可靠信号…`），模型/面板能看到裁剪警示
- **P1-③ select 升级忽略 maxEscalateK**：升级锦标赛 n_evaluations 硬编码 3 → 尊重配置（escK = clamp(maxEscalateK, 2, 8)），k_used 如实上报；预算可行性检查同步按 escK 缩放
- **P2-① select 升级复用调用方 seed**：升级轮剥离 seed——同 seed 同 RNG 会让"独立重评"与首评强相关
- **P2-② progress_update 分数未过 clamp01**：新增导出的 `clampSingleScore`，progress 分数与其它评分路径一样裁剪 + anomaly 标记
- **P2-③ estimateCallMs 混入异类时长**：compare 升级预算改用同 kind（compare）历史中位，不再混入 select/track 时长
- **P2-④ 降级模型 live 复核无节流**：DEGRADED 模型的 4096-8192 token 复核探测加 300s TTL 节流——反复重试不再白烧探测费（fail-closed 不变）
- **P2-⑤ 面板 anomaly 识别不全**：panelLogic hasAnomaly 覆盖 `anomalous_shape_*`/`response_shape_*`（此前只认裁剪类），形态异常现在触发 L1 标注与说明卡
- **P3-① bestofn 尾部数字误吞**：goal 末尾数字 >8 时不再被当 N（`/bestofn 修复 bug 42` 的 "42" 保留在 goal）
- **P3-② VerifierPanel 死代码**：删除与 panelLogic 重复且未使用的本地 extract()/BADGE_LABELS
- **P3-③ history 记录失真**：evaluate_session 补真实 duration_ms（原恒 0）；progress_start 不再写空 scores 数组
- **P3-⑥ 提示词/工具描述缺新 action**：verifierUsageSection 与工具描述补 decompose/evaluate_session
- **P3-⑦ 桥层静默 DEFAULT_CRITERIA**：select/compare 桥 handler 改为显式报错（TS/service 层本就强制 criteria，堵直连桥残留）；新增线程池背压（>200 排队立即报 BridgeOverload 错误响应，防直连洪水）
- 工具描述补 decompose/evaluate_session 用法

### Changed
- **build.sh 与 CI 对齐**：本地构建补 panelLogic.ts 独立编译到 lib/client/（此前只有 CI 编译，本地 `npm test` 会用陈旧面板逻辑产物）
- docs：PROGRESS.md/PLAN.md/ROADMAP.md 同步到 v0.6.1 实况（版本号、测试数、已偿债项）

### Security
- 桥层 criteria 缺省不再静默替换（U-N1 连坐项收口）：直连桥的调用方必须显式传 criteria

## [0.6.1] - 2026-08-24

### Fixed
- **档案表自愈（#1）**：literal-mc 评分响应被动观测 `<score_X>` 标签——连续 3 次无标签即标记模型 DEGRADED，评分 fail-closed 拒绝（不再静默错评）；probe 做 live 复核可自愈恢复。此前 MODEL_PROFILES 写死，上游格式漂移会静默失配。
- **decompose 偶发空响应（#3）**：根因 = 请求未禁用 thinking，隐藏推理吃掉 4096 预算致中文长 JSON 截断/空响应。修：thinking disabled + max_tokens 8192 + 空响应重试 + 括号栈 JSON 截断修复（替代粗暴 `}`*3）。
- **select/compare 结果带真实耗时（#4）**：`duration_ms` 透传，面板/输出显示 `⏱ Ns`；大候选数（≥8）提示走异步 task_start。
- **literal-mc 成本/置信提示（#6）**：采样路径结果自动标注 `literal-mc（默认 K=5 次调用）`；临界分差（<0.15）时警告建议 logprobs 模型复核（含 unstable 分支）。
- **面板 VAL 语义**：非评分动作（task_start/progress_start/progress_close/usage/无结果 task_status）不再误标「LLM 判断」。
- **面板内容显示**：progress/task/usage 卡片显示实际内容（进度分、tracker id、任务状态/结果、用量统计）——此前是空白「正常」卡。
- **卡片中文标题**：全部 action 标题使用中文（进度追踪 · 更新 等），此前是英文原名。

### Changed
- **CI 全量测试（#2）**：harness 依赖的 tools.ts/bestofn 测试（此前只本地跑）搬进公开 CI。根因排查：DSH npm 发布残缺（dsh-tools@0.0.1-rc.1 依赖不存在的 dsh-type-meta），但 host 运行时只需 3 个 registry 可装的包（dsh-tools@0.1.1-rc.2 + cordis@4.0.0-rc.8 + schemastery）→ pnpm 装 + `tsc --noCheck` 转译 → 全量 55+ 项测试进 CI（core/bridge/harness 三 job）。
- **默认模型判别力 A/B 结论（#5）**：flash-vision-exp 与 v4-pro 在粗/细/中文三任务上方向判定一致且正确，reason-first 已修复早期 flat 问题——默认模型无需更换。
- RELEASING.md / github-push 技能升级 v2（CI 闸门、版本三处一致、tgz 完整性、stable 策略、发布后验证）。

### Removed
- 仓库清理（`1eb2ab1`）：删除 6 个无关/一次性脚本（含 mario 游戏调试脚本）、修复 .gitignore `__pycache` typo、清理 tmp_articles。

## [0.6.0] - 2026-08-23

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
