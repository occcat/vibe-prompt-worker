## Summary

<!-- What changed, and why is this the smallest useful solution? -->

## Related issue

<!-- Use "Closes #123" when applicable. If there is no issue, briefly explain why. -->

## Changes

<!-- List the important implementation or documentation changes. -->

-

## Verification

<!-- List the checks you ran and their results. -->

```text
npm test
npx tsc --noEmit
```

## Impact

<!-- Check every affected area. -->

- [ ] Public HTTP API or Worker behavior
- [ ] Authentication or encryption
- [ ] Durable Object / SQLite
- [ ] R2 snapshots
- [ ] Deploy, CI, or Wrangler config
- [ ] Documentation only
- [ ] No externally visible impact

<!-- Describe compatibility, migration, or rollout concerns for any affected public surface. -->

## Checklist

- [ ] The change is focused and does not include unrelated cleanup.
- [ ] Tests were added or updated for behavior changes, or the reason they are unnecessary is explained above.
- [ ] Relevant tests and typecheck pass locally (`npm test` and `npx tsc --noEmit`).
- [ ] README.md and README.zh-CN.md are updated together when operator-facing behavior changes.
- [ ] No credentials, tokens, `AUTH_VALUE`, `vaultPassword`, ciphertext, or personal Worker URLs are included.
