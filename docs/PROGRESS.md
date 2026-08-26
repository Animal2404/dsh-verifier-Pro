# PROGRESS — dsh-verifier-Pro

> 事实记录：每个版本实际完成了什么、验证状态如何。不做承诺（承诺看 PLAN.md）。

## v0.7.4（2026-08-26 — bestofn-refcomp 终版合并报告修复批；v0.7.1-v0.7.3 累积变更随本版 tag 一并首发）

### 已完成（R-refcomp 三透镜审计：defect-hunter / installer-advocate / gap-scout）

| 批次 | 关键事项 | 验证 |
|------|----------|------|
| 实现缺陷 | F1 task_start(track) 收口 runner（sanitize/bound/costGuard/gate/clamp 全覆盖）· F2 literal-mc 部分丢标签逐请求告警 · F3 响应形态检测改进程级事件表（跨线程真正生效）· F4 max_workers 缺省钳制到桥内 worker 数（原 50/500 路 fan-out）· F5 tracker TTL 按最近访问 · F6 track 全 0.5 桥侧护栏 · F7 双⚠️ · F8 unstable 补 duration_ms · F9 evaluate_session 用官方真实步号 · F11 升级 reps 进缓存去重 · F12 compare exact-flat 归因改 extract_score 回退 · F13 JSONL 轮换去忙等（F10 存疑不修） | 离线测试 + py 编译 |
| 能力缺口 | G1 判别力自检 scripts/discriminative_check.py + setup --bench 接入 · G2 真实 token 计量回填 costGuard（usage 差值 EMA，时长粗估兜底）· G3 criteria/ .md 模板库热加载（TEMPLATE+两预设目录版）· G5 verifier config 只读回显 action | node --check / py_compile |
| 安装体验 | F-1 --fix 六步闭环（venv→pip→复核→双写配置→构建→挂载 profile）· F-2 三层 cordis.patch.yml 关系文档化+双写 · M-1 启动无凭据响亮告警 · M-5 npm run build 改纯 Node 入口 build.mjs（Windows 免 bash）· m-1/m-2/m-4/m-9/m-10（--strict/--bench、上界钉扎、改名残留、Python 口径对齐） | node --check |
| 实弹验证 | **G1 判别力基准 4/4 通过**（默认模型 flash-vision-exp @ opencode：粗判别 margin +1.000 / 细判别 +0.106 / 中文 +0.991 / 跑题拒绝 +1.000；脚本首跑全 0.5 踩中「未打标 client → prefill 回退」坑后与桥打标对齐修正）· **G4 多模态 images 首次真实验证**：红蓝方块的带图 select 正确选中红色（index=0，scores 0.654/0.346，LLM_VERIFIER_ALLOW_IMAGES=1）· 附带发现并修复：README 的 probe_logprobs.py 参数顺序与脚本实际签名（base_url api_key model）相反 | 实测 |
| 文档 | README ZH/EN 大修：升级与卸载节、凭据→后端映射表（M-6）、EN 补齐缺失章节与 action 数、端到端示例去硬编码路径、钉扎示例动态措辞、30 秒冒烟+刷新提示 · cordis.patch.yml literal-mc 注释矛盾修正 · ci.yml 加 workflow_dispatch · 本文件版本漂移追平 | grep 核验 |

## v0.7.3（2026-08-26 完成；当时未打 tag，随 v0.7.4 首发发布）

外部评审 4 个确认 bug + 逻辑问题修复（costGuard 单次语义、expandCriteria 收口数值拒绝、
probe 路由矛盾+TTL 缓存、bestofn 输出目录清理正则、history 缓存污染过滤等），测试 94/94。
详见 CHANGELOG。

## v0.7.1 → v0.7.2（2026-08-25 完成；当时未打 tag，随 v0.7.4 首发发布）

v0.7.2 为 R3 vselftest 双成员审计 43 项发现修复（详见 CHANGELOG）；v0.7.1 为小批次文档/协议修订。

## v0.7.0（2026-08-24 发布）

### 已完成（第二轮深度审计修复 + 协议升级 + /vselftest 首轮实战闭环）

| 批次 | 关键事项 | 验证 |
|------|----------|------|
| 审计修复批量 | 成本预算全路径生效、compare flat 警告保留、select 尊重 maxEscalateK、升级剥 seed、progress 分数裁剪、estimateCallMs 按 kind、降级探测 300s 节流、面板 anomaly 全类识别、桥 criteria 显式化 + 线程池背压 | typecheck + 回归测试 |
| 协议升级 | PLAN GATE / REVISION LOOP（≤2轮）/ 对抗性提问闭环 / deep_review+root_cause 探究式预设（单一收口展开）/ 透镜分化 + 相互审阅轮 / BUILD-AUDIT 双轨 /bestofn（审计轨引用核验 + VERIFIED/REPORTED 标注）/ 预算门禁 | 协议文本经 verifier select("deep_review") 三方案评选 + compare K=3 复核产生 |
| /vselftest 首轮实战 | 双成员透镜审计 bestofn↔smoke 边界 → 引用核验 ~20 锚点零伪造 → 交叉审阅两次定级纠偏 → root_cause 终评；18 项发现全部修复（state 自遮蔽、采集器跨运行 k× 膨胀、空名 summary 全局污染、目录幽灵块三重修复、summary 解析收口、unsupported 类别等）；稳定候选标签（sha256[:8]）+ 契约钉扎测试上线 | **72/72** 测试全绿 |

## v0.5.0 → v0.6.x（已发布）

### 已完成（Round A/B/C 审计 P1 全清 → 0.6.x 能力扩展）

| 版本 | 关键事项 | 验证 |
|------|----------|------|
| v0.5.0 | Round A/B/C 三方审计全量修复（F1-F17/S1-S8/U-* 全落地，见 CHANGELOG）；CI（GitHub Actions 三 job）；凭据解析加固；history 轮转 | typecheck + 测试全绿 + 实弹冒烟 |
| v0.6.0 | VAL 验证锚定、声明-证据对照、decompose/evaluate_session、异常分数形态检测、reason-first、maxCostPerVerification 真实实现、probe 1-token 化、面板逻辑抽离可测 | 55+ 测试 + CDP 面板回归 |
| v0.6.1 | 档案表自愈（被动观测 + fail-closed + probe 自愈）、decompose 空响应根因修复、duration_ms/literal-mc 提示、面板内容/中文标题、CI 全量进 harness job | 59/59 测试全绿 |

### 测试现状

- Offline 单测：**72 pass / 0 fail**（`npm test`：并发原语 11 + 升级链回归 + 凭据解析 + 证据链 + 面板逻辑 + 异常形态 + 对抗探针 + bridge_fix 离线套件 + 契约钉扎）
- 面板回归：CDP 截图脚本（scripts/cdp_web_screenshot.mjs）机器实测
- CI：GitHub Actions 三 job（core 纯逻辑 / bridge 桥套件 / harness 全量含依赖 harness 的测试），推送后生效
- 已知遗留（全部低优先级）：verifier ping action、anomaly 连续降级提示、私有符号全量降级、statusWait 2s 轮询、i18n 层缺失——详见 PLAN.md
- Composition/E2E/GUI 层：**未建**（见 PLAN.md）

## v0.4.3 → v0.4.9（已发布）

| 版本 | 关键事项 | 验证 |
|------|----------|------|
| v0.4.3 | P0 加固轮：Client 工程化骨架、并发信号量+LRU、子进程超时、分数裁剪、离线测试基线、文档五件套 | typecheck + 11/11 测试 + build 全绿 |
| v0.4.4 | 网页面板端到端点亮（presentationMeta→block.meta）；凭据优先级修复（401 根因）；client bundle 扁平化+ModuleLoader 包装 | CDP 截图实测 |
| v0.4.5 | 面板中文化（动作名中文+英文小字、徽章中文） | CDP 截图 |
| v0.4.6 | 升级文案去黑话（分差小·已评N次 + 白话说明行） | CDP 截图 |
| v0.4.7 | 全徽章统一白话说明系统 | CDP 截图 |
| v0.4.8 | 视觉三改：同色深底 / ABCD 字母 / 彩色仅徽章 | CDP 截图 |
| v0.4.9 | 说明文字中性化 + 最优方案绿色恢复 | CDP 截图 |

## v0.4.2（已发布）

- Python 桥并发 worker、状态落盘、Windows 一等公民、桥崩溃自重启
- 自适应 K 升级（margin 落噪声带自动 K=3）、exact-flat/degraded 护栏
- probe_logprobs / scan_logprob_models 脚本；setup.mjs 三合一合并版
- 安全事件处置：git filter-repo 清除历史泄露 key + 强推 + key 轮换

## 已知事故记录

| 日期 | 事故 | 处置 |
|------|------|------|
| 2026-08-22 | opencode DFLASH 投机解码导致 deepseek-v4-flash logprob 全灭（400） | 切 deepseek-v4-pro；README 对照表标注 |
| 2026-08-22 | git 历史泄露 sk- 开头 API key | filter-repo 重写历史、强推、轮换 key |
| 2026-08-23 | 内部审计报告误推公有仓库（违反负责任披露） | 撤回（22cf64a）+ .gitignore 兜底 |
| 2026-08-23 | 开发会话中主机蓝屏 ×1 | AgentTeams 文件落盘设计兜底，审计产物零丢失 |
