/**
 * Customer plans and token accounting for the revidapi upstream.
 *
 * Limits are counted in "converted tokens", priced like one Sonnet output token, so a plan's cost
 * ceiling does not depend on how a customer mixes input and output:
 *   output 1 · fresh input 0.36 · cache write 0.36 · cache read 0.036
 *   then x model weight, measured the same way: Opus 5.5 2.36 → 2.4, Haiku 4.5 0.50 → 0.51, Sonnet 1.
 *   Opus 5 was not measured; its list price is ~25% above Opus 5.5, so it is charged x3.
 * The token weights were measured on revidapi itself (2026-11-12, credits_used vs reported usage):
 * input and cache write ≈ 216, cache read ≈ 21.5, output ≈ 628 credits per 1M tokens, i.e. 0.344 / 0.034
 * of output; rounded up here. revidapi adds ~10k cached tokens of its own to every request, so even a
 * one-word answer costs ~0.7 credit — these weights charge that too.
 * Keep in sync with src/admin/pricing.ts (the /admin price calculator).
 */

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS
export const SESSION_MS = 5 * HOUR_MS
export const WEEK_MS = 7 * DAY_MS

/** Plans confirmed with the operator on 2026-11-12 (caps in converted tokens). */
export const PLANS = {
  pro: { id: 'pro', name: 'Pro', sessionCap: 800_000, weeklyCap: 2_500_000 },
  max5x: { id: 'max5x', name: 'Max 5x', sessionCap: 2_500_000, weeklyCap: 10_000_000 },
  max20x: { id: 'max20x', name: 'Max 20x', sessionCap: 7_500_000, weeklyCap: 20_000_000 },
}
export const PLAN_IDS = Object.keys(PLANS)

/** Claude models customers may use, with their cost weight relative to Sonnet. Anything else is refused. */
export const MODEL_WEIGHTS = {
  'claude-sonnet-5-5': 1,
  'claude-sonnet-5': 1,
  'claude-opus-5-5': 2.4,
  'claude-opus-5': 3,
  'claude-haiku-5-5': 0.51,
  'claude-haiku-4-5': 0.51,
}
export const ALLOWED_MODELS = Object.keys(MODEL_WEIGHTS)

export const TOKEN_WEIGHTS = { input: 0.36, cacheWrite: 0.36, cacheRead: 0.036, output: 1 }

/** Total converted tokens a rental of `days` may use: max(one full session, weekly cap prorated by days). */
export const allowance = (plan, days) => Math.max(plan.sessionCap, (plan.weeklyCap * days) / 7)

/** Converted tokens for one answer's usage block (Anthropic shape) on `model`. */
export function convertedTokens(usage, model) {
  const u = usage ?? {}
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0)
  const raw =
    n(u.input_tokens) * TOKEN_WEIGHTS.input +
    n(u.cache_creation_input_tokens) * TOKEN_WEIGHTS.cacheWrite +
    n(u.cache_read_input_tokens) * TOKEN_WEIGHTS.cacheRead +
    n(u.output_tokens) * TOKEN_WEIGHTS.output
  return Math.ceil(raw * (MODEL_WEIGHTS[model] ?? Math.max(...Object.values(MODEL_WEIGHTS))))
}
