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

/**
 * What these tokens would have cost with no prompt caching at all.
 *
 * Unlike a model counterfactual, the token counts here really are invariant, and
 * that distinction is the whole reason this one is worth reporting. Cache-read
 * tokens ARE the context re-sent on every turn; without a cache they would have
 * been sent as ordinary input, one for one. The cache-write premium simply would
 * not have been paid, so those tokens price at the plain input rate too.
 *
 * The remaining assumption, and it is stated in the caveats rather than buried:
 * a cacheless run of the same work would have made the same requests with the
 * same context. That holds far better than "the same task on a weaker model
 * takes the same number of turns", which is why the model scenarios refuse to
 * subtract and this one is allowed to.
 */
export interface NoCacheScenario {
  /** The model these tokens actually ran on. */
  model: string;
  /** Estimated cost as recorded, with cache rates applied. */
  withCache: number;
  /** Estimated cost with every cache token billed at the full input rate. */
  withoutCache: number;
  /** withoutCache - withCache. Positive means caching paid off. */
  saved: number;
  /** `saved` as a fraction of `withoutCache`; absent when that is 0. */
  savedFraction?: number;
  records: number;
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
  /**
   * Per actual model: these same tokens with no caching at all. Empty when
   * nothing in the period used the cache.
   */
  noCache: NoCacheScenario[];
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

    const noCache = this.noCacheScenarios(groups);

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
      noCache,
      pricingVersion: this.costService.pricingVersion,
      caveats: this.caveats(groups, unknown, noCache),
    };
  }

  /**
   * The same tokens with every cache token billed as plain input.
   *
   * Grouped by the model that actually ran, because a blended "you saved $X"
   * across models would hide that the answer differs by an order of magnitude
   * between them.
   */
  private noCacheScenarios(groups: RepriceGroup[]): NoCacheScenario[] {
    const byModel = new Map<string, NoCacheScenario>();

    for (const group of groups) {
      if (group.cacheReadTokens === 0 && group.cacheWriteTokens === 0) continue;

      const billableOutput = billableOutputTokens(
        group.client,
        group.outputTokens,
        group.reasoningTokens,
      );
      const speed = group.speed ? { speed: group.speed } : {};

      const withCache = this.costService.estimate({
        model: group.model,
        inputTokens: group.inputTokens,
        outputTokens: billableOutput,
        cacheReadTokens: group.cacheReadTokens,
        cacheWriteTokens: group.cacheWriteTokens,
        cacheWrite5mTokens: group.cacheWrite5mTokens,
        cacheWrite1hTokens: group.cacheWrite1hTokens,
        ...speed,
      });
      // Every cache token folded into input, and no cache tokens left to price:
      // without a cache those bytes are ordinary input, at the ordinary rate.
      const withoutCache = this.costService.estimate({
        model: group.model,
        inputTokens: group.inputTokens + group.cacheReadTokens + group.cacheWriteTokens,
        outputTokens: billableOutput,
        ...speed,
      });
      if (withCache.estimatedCost === undefined || withoutCache.estimatedCost === undefined) {
        continue;
      }

      const existing = byModel.get(group.model) ?? {
        model: group.model,
        withCache: 0,
        withoutCache: 0,
        saved: 0,
        records: 0,
      };
      existing.withCache += withCache.estimatedCost;
      existing.withoutCache += withoutCache.estimatedCost;
      existing.records += group.records;
      byModel.set(group.model, existing);
    }

    return [...byModel.values()]
      .map((scenario) => {
        scenario.saved = scenario.withoutCache - scenario.withCache;
        if (scenario.withoutCache > 0) {
          scenario.savedFraction = scenario.saved / scenario.withoutCache;
        }
        return scenario;
      })
      .sort((a, b) => b.saved - a.saved || a.model.localeCompare(b.model));
  }

  private caveats(
    groups: RepriceGroup[],
    unknownModels: string[],
    noCache: NoCacheScenario[] = [],
  ): string[] {
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

    if (noCache.length) {
      caveats.push(
        'The no-cache figures rest on a narrower assumption than the model scenarios, which ' +
          'is why they are allowed to state a saving at all: cache-read tokens ARE the ' +
          'context re-sent each turn, so without a cache they would have been sent as ' +
          'ordinary input one for one, and the cache-write premium would simply not have ' +
          'been paid. The assumption that remains is that a cacheless run would have made ' +
          'the same requests carrying the same context.',
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
