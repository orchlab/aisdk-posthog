/**
 * LLM cost calculation using the `llm-info` package.
 *
 * Maps AI SDK model IDs to pricing data and computes USD cost
 * from input/output token counts.
 */

import type { ModelLike } from 'llm-info';
import { getModelInfoWithId, getModelsByApiId } from 'llm-info';

export interface CostBreakdown {
  inputCostUsd?: number;
  outputCostUsd?: number;
  totalCostUsd?: number;
}

/**
 * Calculates split cost breakdown (in USD) for a given model and token usage.
 * Returns input, output, and total costs separately so PostHog can display
 * granular cost data. Returns empty object if model is not recognized.
 */
export function getModelCostBreakdown(
  modelId: string | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): CostBreakdown {
  if (!modelId || (inputTokens === undefined && outputTokens === undefined)) {
    return {};
  }

  const modelInfo = resolveModelInfo(modelId);
  if (!modelInfo) {
    return {};
  }

  const inputPrice = modelInfo.pricePerMillionInputTokens;
  const outputPrice = modelInfo.pricePerMillionOutputTokens;

  if (inputPrice === undefined && outputPrice === undefined) {
    return {};
  }

  const result: CostBreakdown = {};

  if (inputTokens && inputPrice) {
    result.inputCostUsd = (inputTokens / 1_000_000) * inputPrice;
  }
  if (outputTokens && outputPrice) {
    result.outputCostUsd = (outputTokens / 1_000_000) * outputPrice;
  }

  const total = (result.inputCostUsd ?? 0) + (result.outputCostUsd ?? 0);
  if (total > 0) {
    result.totalCostUsd = total;
  }

  return result;
}

/**
 * Resolves model info by trying several ID formats.
 * AI SDK model IDs may differ from llm-info's catalog IDs.
 */
function resolveModelInfo(modelId: string) {
  // Direct lookup (cast to ModelLike — runtime will return undefined for unknowns)
  let info = getModelInfoWithId(modelId as ModelLike);
  if (info) {
    return info;
  }

  // Try by API ID (providers sometimes use different IDs)
  const byApi = getModelsByApiId(modelId);
  if (byApi && byApi.length > 0) {
    return byApi[0];
  }

  // Try stripping provider prefix (e.g., "anthropic.claude-4-sonnet-..." -> "claude-4-sonnet")
  const stripped = modelId.replace(/^[a-z]+\./i, '');
  if (stripped !== modelId) {
    info = getModelInfoWithId(stripped as ModelLike);
    if (info) {
      return info;
    }
  }

  // Try stripping AWS Bedrock cross-region prefix (e.g., "us.anthropic.claude-..." -> "claude-...")
  const bedrockStripped = modelId.replace(/^[a-z]+\.[a-z]+\./i, '');
  if (bedrockStripped !== modelId) {
    info = getModelInfoWithId(bedrockStripped as ModelLike);
    if (info) {
      return info;
    }
  }

  return undefined;
}
