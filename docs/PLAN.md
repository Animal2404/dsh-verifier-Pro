# PLAN — 当前迭代与技术债

> 旧版 PLAN.md 因 GBK/UTF-8 编码损坏无法修复，本版为重写版（2026-08-22），
> 历史决策已并入 ROADMAP.md 的「决策记录」节。
> 目标定位不变：大脑 = LLM-as-a-Verifier（细粒度验证）· 躯干 = dsh-agent-teams（多智能体协作）。

## 迭代目标（v0.4.3 → v0.6.x，当前 HEAD v0.6.1）

P0 阻塞性修复已完成（事实见 PROGRESS.md）。剩余：

### P0-2：核心算法 TS 层护栏（范围已按 ADR-001 收窄）

ADR-001 决策维持 Python 桥，因此**不做全量算法移植**。TS 层护栏清单：

- [ ] `probe` 结果暴露为工具 action（`verifier ping`），模型不支持 logprobs 时 select/compare 前置拦截并给出可操作错误（注：probe_model 已做每调用前置拦截，仅缺显式 ping action）
- [ ] 越界分数异常计数器：同一会话内 anomaly 连续 ≥3 次自动降级提示（建议换模型）
- [ ] 官方包私有符号依赖（`_llm_verifier_deepseek` tag）加 try/降级路径 —— 桥断时回退官方默认行为而非崩溃（注：bridge_fix.install 已有 try/except，tag 有 VERIFIER_BRAIN_NO_TAG 开关，全量降级路径未做）

**重启 ADR-001 辩论的触发条件**（照抄 THIRD_PARTY_ANALYSIS_REVIEW.md §2.2）：
连续 2 次因上游私有符号/供应商行为变更导致桥断裂，且上游 30 天无修复。

### 发布门禁（已达成）

- [x] `npm run verify`（typecheck + test）进 CI（core/bridge/harness 三 job）
- [x] 真实会话冒烟：select / compare / track / progress 各跑通一次
- [x] Web UI 面板在 dsh web 渲染验证（CDP 截图回归）

## 技术债登记簿

| 债 | 影响 | 利息 | 计划偿还版本 |
|----|------|------|------------|
| resultCache 为模块级单例，多 profile 共存时共享 | 极低 | 无 observable bug | 观察中 |
| decompose/evaluate_session 无 checkpoint_steps 校验（同 track 已校验） | 低 | 非法参数透传 | v0.7 |
| evidence_chain 超时后临时产物不清理 | 低 | tmpdir 缓慢增长 | v0.7 |
| bestofn 本地模式 smoke 文件命名依赖证据块名含哈希（隐性耦合） | 低 | 脚本改动易碎 | v0.7 |
| ~~PLAN.md 编码乱码~~ | — | — | ✅ 本版重写已偿还 |
| ~~track/progress 未过评分信号量~~ | — | — | ✅ R3-4/R3-5 已修 |
| ~~client 面板为骨架版~~ | — | — | ✅ v0.4.4 端到端点亮 |
| setup.mjs 千行单体脚本 | 维护性 | 每次改动回归成本高 | v0.7 拆分 |

## 明确不做（Negative decisions）

- 不做 verify_rollout 工具级并行子代理生成 —— /bestofn 团队模式已覆盖该场景
- 不做多文件 AST 合并 —— ADR-002 标注为期货，README 已诚实标注边界
