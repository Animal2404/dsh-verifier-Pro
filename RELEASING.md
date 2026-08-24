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
2. **跑验收脚本**（如存在）：`node scripts/acceptance_ts.mjs` / `node scripts/test_bestofn.mjs` / `.venv/Scripts/python scripts/e2e_bridge_test.py`——跑失败 = 不发
3. **确认 CI 绿**：推当前 HEAD 触发 CI，等 `gh run list --limit 1` 显示 success（core/bridge/harness 三 job 全绿才算绿）。**CI 红 = 不发版**
4. **版本号三处一致**：`package.json` version / `CHANGELOG.md` 最新条目 / git tag 必须一致；CHANGELOG 对照 `git log v上一版..HEAD --oneline` 逐条核对不遗漏
5. `npm pack` 构建 tgz，检查产物：
   - `tar -tzf *.tgz | grep bridge_fix` —— bridge_fix.py 必须在包内
   - `tar -tzf *.tgz | grep pycache` —— 必须为空（`!bridge/__pycache__` 已在 files 排除）
   - `tar -tzf *.tgz | grep -E "lib/(index|tools)\.js"` —— host lib 产物在包内
   - `tar -tzf *.tgz | grep cordis.patch.yml` —— 配置在包内
   - `tar -tzf *.tgz | grep -E "SECURITY|README"` —— **SECURITY.md 与 README(.en).md 必须在包内**（files 白名单显式列出——SECURITY 曾漏加）
   - `tar -tzf *.tgz | grep node_modules` —— 必须为空
6. `git push origin main` + `git tag vX.Y.Z` + `git push origin vX.Y.Z`
7. 发 Release（标题用上面的格式），随后 `gh release edit vX.Y.Z --title "vX.Y.Z — <概括>"`
8. **发布后验证**：`gh release view vX.Y.Z --json name,tagName,assets` 复核标题格式、tag、tgz 资产在位
9. **发布后清理本地 tgz**：删除旧版 `dsh-external-*-<旧版>.tgz`（*.tgz 被 gitignore 不入库，但物理堆积）

## 仓库卫生（推送/发版前顺带核对）

- `git status` 干净 = 无修改 + **无未跟踪残留**（tgz / 根目录 AUDIT-*.md / docs/ 评审文档——`git status --short` 的 `??` 都是残留，该清理/归档）
- `.github/` 至少应有 `workflows/ci.yml`；建议 workflow 有 `workflow_dispatch`（手动触发，发版前复验方便）

## Release notes 结构（推荐）

按分组写，如实不夸大：

```
## vX.Y.Z — <一句话概括>
### Added / ### Fixed（含根因）/ ### Changed / ### Removed（含为什么）
### 工程（CI/测试/文档）/ ### 已知限制（如实）
```

## stable 分支策略

- `stable/<major>.<minor>.x`（如 `stable/0.5.x`）从已发布 tag 创建，代表「可依赖的稳定线」
- 发新版本后：稳定线升级时可开新 stable 分支；旧 stable 保留（仅安全修复）
- **安全/正确性修复 cherry-pick 到当前 stable 分支**；新功能不进
- 忘记维护 stable 不阻塞推送，但 notes 应说明当前 stable 线

## 发布前文档对账

发布前检查以下三份文档与当前代码一致：

- **README.md / README.en.md**：模型推荐、配置示例、action 数量、engines 声明
- **新增能力必须有对应章节**（v0.7.0 教训）：先跑 `git diff <上个tag>..HEAD --stat` 列出本版新增的命令/字段/协议，逐项确认两份 README 都有使用说明——"核对旧内容是否过期"防不住遗漏型错误（/vselftest、双轨协议、稳定标签发版时整体缺席文档，被用户抓到）
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
