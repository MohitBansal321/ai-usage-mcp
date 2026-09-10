---
name: project-cost
description: Break down usage and cost for a single project or repository, or compare every project.
argument-hint: '[absolute-project-path]'
arguments: [project]
---

Report what the project at `$project` has cost me.

If that path is empty, instead compare what each of my projects has cost: call `project_usage`,
then look at the top few with `recent_sessions` to explain what drove the largest one.

If a path was given, call `project_usage` first to confirm the exact path as it is recorded,
then `usage_summary`, `model_usage` and `recent_sessions` with `projectPath` set to it. Report
tokens by class and the cost.

Never add the reported and estimated cost figures together: reported cost is what a client
actually charged, while the estimated figure is an API-equivalent list price for a client that
records no cost. Report anything unavailable as unavailable rather than as zero.
