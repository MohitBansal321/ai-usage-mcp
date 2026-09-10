---
name: why-was-today-expensive
description: Diagnose what actually drove today's coding-agent cost, rather than only reporting the total.
---

Work out what drove my coding-agent cost today, and be specific about the cause.

Call `usage_summary` with `today=true`, then `model_usage` and `project_usage` for today, then
`recent_sessions`. Look especially at the token breakdown: cache reads are usually the largest
class by far, and a long-running session re-reads its whole context on every turn, so cost can
be driven by context size rather than by how much work was asked for. Say which sessions and
projects dominated, and why.

Never add the reported and estimated cost figures together: reported cost is what a client
actually charged, while the estimated figure is an API-equivalent list price for a client that
records no cost. Report anything unavailable as unavailable rather than as zero.
