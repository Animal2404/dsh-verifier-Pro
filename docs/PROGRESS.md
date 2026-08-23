# PROGRESS — dsh-verifier-Pro

> 事实记录：每个版本实际完成了什么、验证状态如何。不做承诺（承诺看 PLAN.md）。

## v0.5.0（当前 HEAD，待发布）

### 已完成（Round A/B 三方审计 P1 全清 + P2 批量）

| 批次 | 关键事项 | 验证 |
|------|----------|------|
| step ① | 诚实性修正（SECURITY.md 虚假声明 → 真实 sanitizeForVerifier 实现）、安装三连（包名/模型/Node 门槛）、编码事故修复、CHANGELOG 补 0.4.7-0.4.9 | typecheck + 测试全绿 |
| step ② | F1 升级链 clamp + anomaly 透传（含面板 warning）；U-B1 escalationModel 接回同步路径 | 5 条升级链回归测试 |
| steps ③④⑤⑥ | F3 NaN 协议加固、F4 images 双洞、F5 监听器泄漏、F6 共享并发闸门 + 服务缝走 runner（U-N2/U-N9）、U-N1 task_start 加固；F7-F13/F15-F17、U-B2/B3/B5/B6、U-N4/N5/N14 等批量；CI（GitHub Actions）；凭据解析加固（U-B4/U-N11/U-N7）+ history 轮转 | typecheck + **24/24** 测试 + build 全绿 + 实弹冒烟 |
| prompt 对账 | /bestofn 提示词三处对齐实际行为：证据链绝对路径（U-N5 同款 bug）、unknown-smoke 三态（U-N14）、anomaly/warning 转述义务（F1） | typecheck + 测试 |

### 测试现状

- Offline 单测：**24 pass / 0 fail**（`npm test`：并发原语 11 + 升级链回归 5 + 凭据解析 8）
- 面板回归：CDP 截图脚本（scripts/cdp_web_screenshot.mjs）机器实测
- CI：GitHub Actions（build + host/client typecheck + 离线单测），推送后生效
- 已知遗留（全部低优先级）：F14 死配置 maxCostPerVerification（文档已如实标注 v0.6.0 待办）、U-N8 Semaphore 死 API、statusWait 2s 轮询、i18n 层缺失——详见 CHANGELOG 0.5.0 与本地审计清单（AUDIT-*.md 不入库）
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
