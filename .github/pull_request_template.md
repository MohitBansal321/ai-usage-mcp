## What this changes

<!-- Brief description. Link an issue if there is one. -->

## Checklist

- [ ] `npm run check` passes (typecheck, lint, format, build, tests)
- [ ] If a collector changed: `ai-usage verify` still reports a zero delta
- [ ] If the on-disk format understanding changed: `docs/DATA_SOURCES.md` updated in this PR
- [ ] No fabricated values — anything a source does not report stays `unavailable`
