---
name: daily-review
description: Review coding-agent usage over a period - totals, which client and model dominated, and how it compares with the days around it.
argument-hint: '[days]'
arguments: [days]
---

Review my coding-agent usage for the last `$days` days. If that is empty, use 7.

Call `usage_summary` for the period, then `daily_usage` to see the shape of it, then
`client_usage` and `model_usage` to see where it went. Tell me the total, which day was
heaviest, and which client and model dominated.

Never add the reported and estimated cost figures together: reported cost is what a client
actually charged, while the estimated figure is an API-equivalent list price for a client that
records no cost. Report anything unavailable as unavailable rather than as zero.
