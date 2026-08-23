# RELEASING — 发布约定（dsh-verifier-brain）

> 每次发布前对照本清单执行。

## Release 标题格式（必须）

GitHub Release 标题必须用**描述性标题**，格式：`vX.Y.Z — <一句话概括本版>`

- ✅ `v0.5.0 — 四轮审计全量修复 + 模型生态解锁 + 面板透明化`
- ❌ `@dsh-external/dsh-verifier-pro v0.5.0`（工具默认，勿用）

设置方式：

```powershell
# 创建 Release 后立即改标题（或 gh release create 时用 --title）
gh release edit v0.5.0 --title "v0.5.0 — <一句话概括>"
```

## 发布流程

1. `npm run verify`（typecheck + 全量测试）全绿
2. 确认 CHANGELOG.md 有本版条目
3. `npm pack` 构建 tgz，检查产物：
   - `tar -tzf *.tgz | grep bridge_fix` —— bridge_fix.py 必须在包内
   - `tar -tzf *.tgz | grep pycache` —— 必须为空（`!bridge/__pycache__` 已在 files 排除）
4. `git push origin main` + `git tag vX.Y.Z` + `git push origin vX.Y.Z`
5. 发 Release（标题用上面的格式）

## 发布前文档对账

发布前检查以下三份文档与当前代码一致：

- **README.md / README.en.md**：模型推荐、配置示例、action 数量、engines 声明
- **LICENSE**：BSD-3-Clause（与 package.json license 字段一致）
- **SECURITY.md**：安全声明与实现一致（历史教训：sanitizeForVerifier 曾虚报——文档必须如实）

## 发版前验证清单（#17 元问题：速度优先于验证）

每次声称「完成/已修复」前，必须逐项验证，不得凭印象断言：

1. `npm run verify`（typecheck + 全量测试）全绿——**不是部分测试**
2. 涉及桥的改动：`python -m py_compile bridge/*.py` + 桥套件 `python tests/test_bridge_fix.py`
3. 涉及面板的改动：`tsc -p tsconfig.client.json` + `node --test tests/panel-logic.test.mjs`
4. **实弹验证**：涉及评分/工具行为的改动，至少跑一次真实 verifier 调用确认（不是只看单测）
5. 声称「借鉴 X 项目」前：**确认 X 的真实机制**，防止概念错配（历史教训：majority 短路误标 uson1x——借名未对齐机制，后被移除）
6. CI 绿（若推送）

## 同 commit 更新文档规则（#18 元问题：文档滞后于功能）

**功能/修复与文档必须在同一个 commit**，禁止「先改代码后补文档」：

- 加 action → 同 commit 更新 README action 列表 + panelLogic ACTION_LABELS + CHANGELOG
- 加配置 → 同 commit 更新 README 配置表
- 改错误信息 → 同 commit 检查 FAQ/双语
- 任何行为变更 → 同 commit 在 CHANGELOG 记一行

> 历史教训：decompose/evaluate_session 加了两个月，README 还写「9 个 action」、
> 面板 ACTION_LABELS 缺标签——都是「先功能后文档」造成的滞后，已在 0.6.0 前修正。
