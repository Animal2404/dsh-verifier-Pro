# criteria 模板库

`verifier select/compare` 的 `criteria` 参数除了内置预设名（`deep_review` /
`root_cause`）、官方预设名（如 `terminal_bench`）和 JSON 描述对象外，还可以是
**本目录下的 `.md` 模板名**：传 `code_review` 即加载 `criteria/code_review.md`。

## 格式

每个 `## 标准名` 二级标题是一个评分维度，标题下的正文是该维度的打分标准
（自然语言描述，会进入评分提示词）。一级标题与散落散文被忽略：

```markdown
# 模板标题（忽略）

## Correctness
输出是否事实正确——引用可验证的事实来源，编造成分直接 LOW。

## Completeness
是否完整覆盖需求的所有验收点。
```

- **热加载**：每次评分调用即读盘，改完模板立即生效，无需重启 dsh。
- **覆盖内置预设**：本目录下的 `deep_review.md` / `root_cause.md` 优先于代码内
  同名预设；删除文件即回退内置版本。
- **名字约束**：模板名只允许 `A-Za-z0-9_-`（防路径穿越）。
- **权重不支持**：llm-verifier 把维度值当描述文本处理；如需加权，请在
  `problem` 里显式说明各维度的相对重要性。
