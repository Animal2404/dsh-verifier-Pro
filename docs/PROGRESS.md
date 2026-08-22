# PROGRESS — dsh-verifier-Pro

> 事实记录：每个版本实际完成了什么、验证状态如何。不做承诺（承诺看 PLAN.md）。

## v0.4.9（当前 HEAD）

### 已发布（v0.4.3 → v0.4.9，全部推 GitHub + tag）

| 版本 | 关键事项 | 验证 |
|------|----------|------|
| v0.4.3 | P0 加固轮：Client 工程化骨架、并发信号量+LRU、子进程超时、分数裁剪、离线测试基线、文档五件套 | typecheck + 11/11 测试 + build 全绿 |
| v0.4.4 | 网页面板端到端点亮（presentationMeta→block.meta）；凭据优先级修复（401 根因）；client bundle 扁平化+ModuleLoader 包装 | CDP 截图实测 |
| v0.4.5 | 面板中文化（动作名中文+英文小字、徽章中文） | CDP 截图 |
| v0.4.6 | 升级文案去黑话（分差小·已评N次 + 白话说明行） | CDP 截图 |
| v0.4.7 | 全徽章统一白话说明系统 | CDP 截图 |
| v0.4.8 | 视觉三改：同色深底 / ABCD 字母 / 彩色仅徽章 | CDP 截图 |
| v0.4.9 | 说明文字中性化 + 最优方案绿色恢复 | CDP 截图 |

### 测试现状

- Offline 单测：**11 pass / 0 fail**（`npm test`，测试文件非法 UTF-8 待修——Round B U-N1b）
- 面板回归：CDP 截图脚本（scripts/cdp_web_screenshot.mjs）机器实测
- 已知缺口（Round B 审计）：升级链 clamp 绕过（F1）、SECURITY.md 曾虚报（F2，v0.5.0 已改口+真实现）、NaN 协议挂死（F3）、images 双洞（F4）等，详见本地审计清单（AUDIT-*.md 不入库）
- Composition/E2E/GUI 层：**未建**（见 PLAN.md）

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
