# ROADMAP — 里程碑与决策记录

> 旧版因 GBK/UTF-8 编码损坏无法修复，本版为重写版（2026-08-22）。
> 旧版已完成事项的事实记录已迁入 PROGRESS.md。

## 决策记录（ADR 摘要）

### ADR-001：Python 桥 vs Pure TS Port —— 维持 Python 桥
- **理由**：DSH `ctx.llm` 流式接口不暴露 logprobs；TS 移植 = 自建 HTTP 栈，复杂度守恒而非消灭。
- **让步整改**：(a) 启动 ping 输出评分路径与健康度；(b) 对官方包私有符号依赖加 try-降级。
- **重启辩论条件**：连续 2 次因上游私有符号/供应商行为变更导致桥断裂，且上游 30 天无修复。

### ADR-002：Best-of-N 合并范围 —— 仅排名 + 单文件文本层合并
- 多文件语义合并标注为期货；README 已诚实标注边界。
- **重启辩论条件**：用户明确付费需求 + AST diff 库成熟可用。

### ADR-003：Verifier 协议标准化 —— 先内部统一，再推生态 spec
- **重启辩论条件**：≥2 个外部插件表达接入意愿。

## 里程碑

### v0.5.0 — 安全与稳定基线（当前迭代收尾）
- [x] Client 侧工程化骨架（面板可构建、可注入）
- [x] 并发信号量 + LRU 缓存 + 子进程超时 + 分数裁剪
- [x] 离线测试基线（node:test，`npm test`）
- [ ] probe 前置拦截 + anomaly 连续降级提示 + 私有符号 try-降级（P0-2 收尾）
- [ ] CI（GitHub Actions：typecheck + test）
- [ ] 真实会话四工具冒烟 + Web UI 渲染验证

### v0.6.0 — 可观测性与体验
- [ ] 结构化错误码 + 会话事件留痕（verifier/* 事件流，client 面板消费）
- [ ] usage/cost 工具 action 增强（token 计量接 maxCostPerVerification 强制执行）
- [ ] track/progress 过信号量；evidence_chain 超时临时文件清理
- [ ] Composition 测试层（scratch profile 加载 + patch 层序校验脚本）

### v0.7.0 — 生态对齐
- [ ] Criteria `.md` 文件热加载 + 领域模板库（对标官方 criteria/ 目录）
- [ ] AgentTeams 深度集成：验证节点进任务 DAG、跨模型分数归一化调研
- [ ] setup.mjs 拆分模块化；SECURITY.md 演进为漏洞披露流程

### v1.0.0 — 生产就绪
- [ ] E2E/GUI 测试层补全；混沌测试（杀桥进程/重启恢复）
- [ ] 元验证机制评估（dsh-proof 式只读复核层）
- [ ] 本地评分模型支持评估（隐私场景）

## 远期观察池（不做承诺）

- 跨模型分数校准（z-score / isotonic regression）—— 待多模型混用成为真实用户场景
- 评分解释生成（自然语言 rationale）—— 待官方包暴露原始比较日志
