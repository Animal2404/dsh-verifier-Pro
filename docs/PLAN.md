# PLAN — 当前迭代与技术债

> 旧版 PLAN.md 因 GBK/UTF-8 编码损坏无法修复，本版为重写版（2026-08-22），
> 历史决策已并入 ROADMAP.md 的「决策记录」节。
> 目标定位不变：大脑 = LLM-as-a-Verifier（细粒度验证）· 躯干 = dsh-agent-teams（多智能体协作）。

## 迭代目标（v0.4.3 → v0.5.0）

P0 阻塞性修复已完成 6/7（事实见 PROGRESS.md）。剩余：

### P0-2：核心算法 TS 层护栏（范围已按 ADR-001 收窄）

ADR-001 决策维持 Python 桥，因此**不做全量算法移植**。TS 层护栏清单：

- [ ] `probe` 结果暴露为工具 action（`verifier ping`），模型不支持 logprobs 时 select/compare 前置拦截并给出可操作错误
- [ ] 越界分数异常计数器：同一会话内 anomaly 连续 ≥3 次自动降级提示（建议换模型）
- [ ] 官方包私有符号依赖（`_llm_verifier_deepseek` tag）加 try/降级路径 —— 桥断时回退官方默认行为而非崩溃

**重启 ADR-001 辩论的触发条件**（照抄 THIRD_PARTY_ANALYSIS_REVIEW.md §2.2）：
连续 2 次因上游私有符号/供应商行为变更导致桥断裂，且上游 30 天无修复。

### 发布门禁（v0.5.0 前）

- [ ] `npm run verify`（typecheck + test）进 CI
- [ ] 真实会话冒烟：select / compare / track / progress 各跑通一次
- [ ] Web UI 面板在 dsh web 渲染验证

## 技术债登记簿

| 债 | 影响 | 利息 | 计划偿还版本 |
|----|------|------|------------|
| resultCache 为模块级单例，多 profile 共存时共享 | 极低 | 无 observable bug | v0.6 |
| track/progress 未过评分信号量 | 低（单步调用轻量） | 并发风暴理论可能 | v0.6 |
| client 面板为骨架版（事件订阅接口未与 host 对接） | 中 | Web UI 显示空列表 | v0.5.x |
| evidence_chain 超时后临时 cache 文件不清理 | 低 | tmpdir 缓慢增长 | v0.6 |
| ~~PLAN.md 编码乱码~~ | — | — | ✅ 本版重写已偿还 |
| setup.mjs 千行单体脚本 | 维护性 | 每次改动回归成本高 | v0.7 拆分 |

## 明确不做（Negative decisions）

- 不做 verify_rollout 工具级并行子代理生成 —— /bestofn 团队模式已覆盖该场景
- 不做多文件 AST 合并 —— ADR-002 标注为期货，README 已诚实标注边界
