---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-03-rainy-project-memory

[English](2026-10-03-rainy-project-memory.md) | 中文

## 概述

新增记录项目记忆召回及限额辅助提炼请求和结果的持久化事件，不修改 Session 写入版本。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-03-rainy-project-memory
baseline: false
changes:
  - root: "event:rainy/memory-recall"
    previous: null
    after: "41a05690413236e478d40076e5b429f8f709b33850e8f82ad697cf4392416ed5"
    decision: same-version
  - root: "event:rainy/memory-request"
    previous: null
    after: "9e6fb990a1187b75f7fea3bd945a14aa036e45cd065bb856e14fa0dd10cb54b4"
    decision: same-version
  - root: "event:rainy/memory-result"
    previous: null
    after: "595429b6d1da139469da81b62dada2932a4312ba65685dd6b571cd9d96c08425"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有事件、消息和头部字段的 schema 保持不变。三个新增根记录实际召回和辅助推理证据。不认识这些必读事件类型的读取器会拒绝新记录；已有记录仍可读取。召回复用现有 session-reference 消息来源，因此不需要修改封闭的消息来源联合类型或替换历史格式。

<a id="verification"></a>
## 验证

在 apps/rainy-desktop 执行 node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/project-memory.test.ts，9 项测试通过，覆盖召回及请求限额、项目隔离、前台取消、修订保留和已删除证据排除。持久化检查器仅报告三个新增根，均允许同版本确认。

<a id="dev-note"></a>
## 开发备注

无。
