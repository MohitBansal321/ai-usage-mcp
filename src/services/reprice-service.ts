import type { TurnRow, UsageRepository } from '../db/repositories/usage-repository.js';
import { ESTIMATED_CLIENTS, type CostService, type EstimateInput } from './cost-service.js';

export interface RepriceResult {
  /** Models whose stored rows gained an estimate. */
  models: string[];
  /** Rows that did. */
  records: number;
}

/**
 * The estimate input for a stored turn -- the same fields, from the same
 * tokens, that the Claude Code collector passes when it first prices the turn,
 * so a re-priced row matches what a full re-sync would write.
 */
function estimateInput(turn: TurnRow): EstimateInput {
  return {
    model: turn.model,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheWriteTokens: turn.cacheWriteTokens,
    cacheWrite5mTokens: turn.cacheWrite5mTokens,
    cacheWrite1hTokens: turn.cacheWrite1hTokens,
    ...(turn.speed ? { speed: turn.speed } : {}),
  };
}

/**
 * Prices stored rows the table could not price when they were collected.
 *
 * Collection prices a row once. A row whose model the table did not know is
 * stored `unavailable`, and incremental sync never reads it again -- so a price
 * that arrives later (a release, an override, the community list) would apply
 * to new turns only, leaving a session half priced. This closes that gap. It
 * only ever moves a row from `unavailable` to `estimated`: a row already priced
 * keeps its number, and a row the client reported a cost for is never touched.
 */
export class RepriceService {
  constructor(
    private readonly repo: UsageRepository,
    private readonly costService: CostService,
  ) {}

  repriceUnpriced(): RepriceResult {
    const result: RepriceResult = { models: [], records: 0 };
    const models = this.repo.unpricedModelsNowPriced(
      ESTIMATED_CLIENTS,
      this.costService.pricedModels(),
    );
    for (const model of models) {
      const estimates: { id: string; estimatedCost: number }[] = [];
      for (const turn of this.repo.unpricedTurns(ESTIMATED_CLIENTS, model)) {
        const estimate = this.costService.estimate(estimateInput(turn));
        if (estimate.costBasis === 'estimated' && estimate.estimatedCost !== undefined) {
          estimates.push({ id: turn.id, estimatedCost: estimate.estimatedCost });
        }
      }
      const written = this.repo.setEstimates(estimates);
      if (written > 0) {
        result.models.push(model);
        result.records += written;
      }
    }
    return result;
  }
}
