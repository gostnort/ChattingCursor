# 分支与 crewAI 参考代码策略

> **Cursor rule:** The same policy lives in [`.cursor/rules/branch-strategy.mdc`](../.cursor/rules/branch-strategy.mdc). You can delete this file once you no longer need a standalone doc copy.

## main 分支

- `crewAI/` 目录写入 `.gitignore`，**不会**被提交到 main
- 适合发布、GitHub Pages 部署、对外协作

本地仍可保留 `crewAI/` 文件夹用于阅读参考，不影响开发。

## dev / feature 分支

开发多 Agent 编排时，可在分支上保留 crewAI 参考：

1. 从 main 创建分支：`git checkout -b dev`
2. 编辑 `.gitignore`，注释或删除 `crewAI/` 行
3. 将本地 `crewAI/` 加入该分支的提交（可选，体积较大）

## 为何这样设计

- main 保持精简，避免 3000+ 参考文件污染主仓库
- 开发分支可对照 crewAI 的 Agent / Task / Crew / Event 模式实现 TypeScript 编排层
- ChattingCursor **不依赖** crewAI Python 运行时，仅借鉴概念
