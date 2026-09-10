import type {
  AggregateRow,
  RepriceGroup,
  UsageFilter,
  UsageRepository,
} from '../db/repositories/usage-repository.js';
import { billableOutputTokens, type CostService } from './cost-service.js';

export interface CounterfactualScenario {
  model: string;
  /**
   * What these exact tokens would have cost at this model's list rates. Always
   * an estimate, never comparable to a `reported` figure as a single number.
   */
  estimatedCost: number;
  /** Records whose tokens are included in `estimatedCost`. */
  records: number;
  /** True for the model the tokens actually ran on, when it is one of the targets. */
  isActual: boolean;
  /** Groups this model could not price. Normally zero: targets are priced by definition. */
  unpricedGroups: number;
}

export interface CounterfactualReport {
  period: { since?: string; until?: string; label: string };
  includeSubagents: boolean;
  /** Actual totals, with `reported` and `estimated` kept apart as everywhere else. */
  overall: AggregateRow;
  /** The (client, model, speed) groups the scenarios were computed from. */
  groups: RepriceGroup[];
  /** Cheapest first. */
  scenarios: CounterfactualScenario[];
  pricingVersion: string;
  /** Things that would make a reader over-trust the comparison. Never empty. */
  caveats: string[];
}

/**
 * "These tokens on a different model."
 *
 * The arithmetic is easy and the honesty is not. Three rules this exists to
 * enforce, beyond the ones {@link CostService} already applies:
 *
 *  1. **A counterfactual is not a saving.** Token counts are not invariant across
 *     models: the same task on a weaker model routinely takes more turns, and a
 *     bigger context re-read on every one. This reports what these tokens would
 *     have cost, which is not what the work would have cost. That caveat ships
 *     with the numbers rather than living in a doc.
 *  2. **Re-pricing needs the client and the speed**, not just the token counts --
 *     reasoning tokens sit inside output for one client and beside it for
 *     another, and fast mode bills at a premium. Hence the (client, model, speed)
 *     grouping.
 *  3. **Reported cost stays reported.** The actual figure keeps its own basis and
 *     is never merged with, or subtracted from, an estimated scenario.
 */
export class CounterfactualService {
  constructor(
    private readonly repo: UsageRepository,
    private readonly costService: CostService,
  ) {}

  /**
   * @param models Target models. Defaults to every model the pricing table knows.
   */
  counterfactual(filter: UsageFilter, label: string, models?: string[]): CounterfactualReport {
    const groups = this.repo.repriceGroups(filter);
    const overall = this.repo.totals(filter);

    const requested = models?.length ? models : this.costService.pricedModels();
    const unknown = requested.filter((m) => !this.costService.knowsModel(m));
    const targets = requested.filter((m) => this.costService.knowsModel(m));

    const actualModels = new Set(groups.map((g) => g.model));

    const scenarios: CounterfactualScenario[] = targets.map((model) => {
      let estimatedCost = 0;
      let records = 0;
      let unpricedGroups = 0;

      for (const group of groups) {
        const estimate = this.costService.estimate({
          model,
          inputTokens: group.inputTokens,
          // Not group.outputTokens: for a client whose reasoning is a sibling of
          // output, pricing output alone bills nothing for the thinking.
          outputTokens: billableOutputTokens(
            group.client,
            group.outputTokens,
            group.reasoningTokens,
          ),
          cacheReadTokens: group.cacheReadTokens,
          cacheWriteTokens: group.cacheWriteTokens,
          cacheWrite5mTokens: group.cacheWrite5mTokens,
          cacheWrite1hTokens: group.cacheWrite1hTokens,
          // The premium only applies where the target model offers fast mode;
          // CostService falls back to standard rates when it does not.
          ...(group.speed ? { speed: group.speed } : {}),
        });
        if (estimate.costBasis !== 'estimated' || estimate.estimatedCost === undefined) {
          unpricedGroups += 1;
          continue;
        }
        estimatedCost += estimate.estimatedCost;
        records += group.records;
      }

      return {
        model,
        estimatedCost,
        records,
        isActual: actualModels.has(model),
        unpricedGroups,
      };
    });

    scenarios.sort((a, b) => a.estimatedCost - b.estimatedCost || a.model.localeCompare(b.model));

    return {
      period: {
        ...(filter.since ? { since: filter.since } : {}),
        ...(filter.until ? { until: filter.until } : {}),
        label,
      },
      includeSubagents: filter.includeSubagents !== false,
      overall,
      groups,
      scenarios,
      pricingVersion: this.costService.pricingVersion,
      caveats: this.caveats(groups, unknown),
    };
  }

  private caveats(groups: RepriceGroup[], unknownModels: string[]): string[] {
    const caveats: string[] = [
      'A counterfactual, not a saving: this is what these exact tokens would have cost at ' +
        'another model’s list rates. It is not what the work would have cost. The same task ' +
        'on a different model generally takes a different number of turns and carries a ' +
        'different context on each one, and no local data can tell us what that number ' +
        'would have been.',
      'Every scenario is an API-equivalent estimate at list prices. On a Claude Pro/Max ' +
        'subscription the marginal cost per request is $0.',
    ];

    if (groups.some((g) => g.speed === 'fast')) {
      caveats.push(
        'Some turns ran in fast mode, which bills at premium rates and is offered on Opus 5 ' +
          'and Opus 4.8 only. Scenarios for a model without fast rates price those turns at ' +
          'standard rates, so they compare cost without comparing latency.',
      );
    }

    const unrecordedSpeed = groups.filter((g) => g.speed === undefined);
    if (unrecordedSpeed.length) {
      const records = unrecordedSpeed.reduce((sum, g) => sum + g.records, 0);
      caveats.push(
        `${records} record(s) have no recorded speed -- either the source never reported one, ` +
          'or they were collected before speed was stored. They are priced at standard rates; ' +
          '`ai-usage sync --full` re-reads the sources and fills in what they do report.',
      );
    }

    if (unknownModels.length) {
      caveats.push(
        `No price for ${unknownModels.join(', ')} in pricing table ` +
          `${this.costService.pricingVersion}; requested but omitted rather than guessed.`,
      );
    }

    return caveats;
  }
}
