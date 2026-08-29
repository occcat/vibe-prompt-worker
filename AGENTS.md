# Agent 约定

本文件只约束编码与提交。不要把产品计划或业务说明写进这里。

## 提交

每个提交必须使用 [Conventional Commits](https://www.conventionalcommits.org/)。

- subject 一行：`type(scope): 摘要`
- subject 之后必须空一行，再写**多行正文**
- 正文必须写明：
  1. **行为**：这次提交改变了什么可观察行为
  2. **兼容边界**：什么必须保持不变
  3. **验证命令**：如何验证（写具体命令，禁止只写「已测试」）
- 禁止只有一行 subject 的提交
- 禁止把正文塞进 subject

示例：

```
feat(auth): reject requests without bearer token

未带 Authorization 的写操作返回 401 unauthorized。
不改变 /v1/health 的无鉴权短路。
验证：`npm test -- auth`
```

`type` 使用 `feat` / `fix` / `docs` / `test` / `refactor` / `chore` / `ci`。`scope` 用模块名。

## 编码

对齐 vibe-prompt（`.swift-format` 与现有提交纪律），按本仓库语言落地：

- 空格缩进，不用 Tab。本仓库 TypeScript **2 空格**（与 vibe-prompt Swift 相同）。
- 行宽 100。连续空行最多 1 行。
- 标识符 ASCII；类型名大写驼峰；其余 lowerCamelCase。
- 导入有序，不提交未使用导入。
- 多元素集合保留尾逗号。
- 文档用 `//` 或 JSDoc；不要用块注释堆砌。
- 不在表达式里赋值。
- 不扩大任务范围：不顺手重构无关代码。
- 不提交密钥、口令、`.dev.vars`、备份密文、生成物。
