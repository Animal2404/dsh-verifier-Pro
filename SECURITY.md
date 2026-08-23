# 安全策略 SECURITY.md

## 报告漏洞

**不要**通过公开 GitHub Issue 报告安全漏洞。

请使用 [GitHub Private Vulnerability Reporting](https://github.com/Animal2404/dsh-verifier-Pro/security/advisories/new)
（仓库 Settings → Security → Private vulnerability reporting）。

- 响应目标：48 小时内确认收到，7 天内给出评估
- 请包含：影响版本、复现步骤、影响评估（评分操纵/凭据泄露/RCE 等）、若可能附最小复现

## 支持版本

| 版本 | 支持状态 |
|------|---------|
| latest（0.6.x） | ✅ 接收修复 |
| 0.5.x | ⚠️ 仅重大安全修复 |
| 更早版本 | ❌ 仅建议升级 |

## 已知安全边界与设计取舍

### 已加固（v0.4.3 起累积）
1. **传输层输入加固（v0.5.0 落地）**：候选/问题/轨迹文本经 `sanitizeForVerifier`——10k 长度上限（截断标注）、剥离 JSONL 帧破坏控制符、对已知指令劫持短语做中性化替换。**覆盖范围如实声明**：这是运输层防御（防协议破坏与常见注入短语），**不是提示词注入的完备防护**——vendored 官方包在提示词内嵌候选文本，结构化槽位需上游支持（见残留风险 1）
2. **分数越界裁剪**：verifier 返回值 clamp 到 [0,1]；越界打 `anomaly` 标记并要求人工复核
3. **凭据零打印纪律**：setup.mjs / 工具输出只显示键名；bridge stderr 不回显 env
4. **git 历史卫生**：2026-08-22 发生过 key 泄露事故，已 filter-repo 重写 + 轮换；后续提交前建议跑 gitleaks 类扫描

### 已知残留风险（如实披露）
1. **提示词注入非根治**：sanitize 为缓解非消除；结构化槽位需官方包支持。恶意构造的候选仍可能影响评分质量（不影响宿主机安全）。追平 uson1x 的"候选 JSON 转义入槽"需官方包提供结构化槽位 API
2. **子代理全工具权限**：团队成员可访问宿主全部工具（rollout 型功能上线前须配沙箱 profile）
3. **评分数据出域**：候选全文发送给配置的 OpenAI 兼容后端。敏感场景请自建本地兼容端点

### 上报范围外
- 依赖链漏洞（llm-verifier/cordis 等上游）：请同时向上游报告
- 对 DSH 本体的问题：报告至 deepseek-harness 仓库
