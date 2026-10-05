---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-03-rainy-project-memory

English | [中文](2026-10-03-rainy-project-memory.zh.md)

## Summary

Adds durable events for project-memory recall and bounded auxiliary extraction requests and results without changing the Session writer version.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing events, messages and header fields retain their schemas. The three added roots record exact recall and auxiliary inference evidence. Readers that do not recognize required event types refuse those new records; existing records remain readable. Recall uses the existing session-reference message source, so no closed message-source union changes or historical format replacements are required.

<a id="verification"></a>
## Verification

From apps/rainy-desktop, node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/project-memory.test.ts passed 9 tests covering bounded recall and requests, project isolation, foreground cancellation, revision preservation and deleted-evidence exclusion. The persistence checker reported only three added roots, each allowing a same-version acknowledgement.

<a id="dev-note"></a>
## Dev Note

None.
