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
