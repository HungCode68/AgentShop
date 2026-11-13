import type { PlanId } from './api'

/**
 * Pack pricing for the /admin page.
 *
 * The gateway sells the four revidapi credit packs at fixed prices (130k / 300k / 700k / 1.400k)
 * with no time limit: the customer uses the pack whenever, until the credits run out. There is
 * no more per-day rental length to interpolate, so this file is just the confirmed price table
 * and a rough "how many tokens is a pack worth" estimate for display.
 *
 * Credits per pack (revidapi's own packs):
 *   Starter 1.500 (99.000đ) · Pro 5.000 (279.000đ) · Business 13.000 (679.000đ) · Enterprise 30.000 (1.339.000đ)
 *
 * Sale prices confirmed 2026-11-13: 130k / 300k / 700k / 1.400k.
 *
 * The token estimate is computed from revid's per-model credit rates for a typical Claude Code
 * turn (see TYPICAL_TURN). It is an estimate - the hard limit is the credit count itself, which
 * the gateway enforces exactly.
 */

export interface Pack {
  id: PlanId
  name: string
  /** revidapi credits the customer may use in total. */
  credits: number
  /** What we buy the pack for (VND). */
  costVnd: number
  /** What we charge the customer (VND). Confirmed 2026-11-13. */
  priceVnd: number
}

export const PACKS: Pack[] = [
  { id: 'starter', name: 'Starter', credits: 1_500, costVnd: 99_000, priceVnd: 130_000 },
  { id: 'pro', name: 'Pro', credits: 5_000, costVnd: 279_000, priceVnd: 300_000 },
  { id: 'business', name: 'Business', credits: 13_000, costVnd: 679_000, priceVnd: 700_000 },
  { id: 'enterprise', name: 'Enterprise', credits: 30_000, costVnd: 1_339_000, priceVnd: 1_400_000 },
]

/** The free trial: 100k tokens, for a duration in minutes set per key by the admin. */
export const TRIAL = { id: 'trial', name: 'Dùng thử', credits: 0, tokenCap: 100_000, priceVnd: 0, defaultMinutes: 60 }

export type ModelId = 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'claude-haiku-5-5'

/** revidapi credits per 1M tokens - same table as MODEL_RATES in gateway/src/plans.js. */
export const MODEL_RATES: Record<ModelId, { in: number; write: number; read: number; out: number }> = {
  'claude-sonnet-5-5': { in: 129, write: 230, read: 36, out: 646 },
  'claude-opus-5-5': { in: 338, write: 510, read: 53, out: 1506 },
  'claude-haiku-5-5': { in: 65, write: 115, read: 18, out: 325 },
}
export const MODEL_LABELS: Record<ModelId, string> = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
}

/**
 * A typical Claude Code turn: the conversation is re-read from revid's cache, a little is new,
 * and the answer is short. Tokens here are what Claude Code itself counts (cache included).
 */
export const TYPICAL_TURN = { cacheRead: 40_000, cacheWrite: 2_000, output: 1_000 }

/** Tokens one credit buys on `model` for the typical turn above. */
export function tokensPerCredit(model: ModelId): number {
  const r = MODEL_RATES[model]
  const t = TYPICAL_TURN
  const credits = (t.cacheRead * r.read + t.cacheWrite * r.write + t.output * r.out) / 1e6
  return (t.cacheRead + t.cacheWrite + t.output) / credits
}

/** Rough tokens a pack is worth on `model`. An estimate for display; the credit count is the real limit. */
export const tokensWorth = (credits: number, model: ModelId = 'claude-sonnet-5-5') => credits * tokensPerCredit(model)

/** Short token count: "25,4M", "1,2 tỷ". */
export function fmtTokenCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ`
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}M`
  return `${Math.round(n / 1000).toLocaleString('vi-VN')}k`
}

/** Worst case we can ever lose on a pack if the customer uses it all: always the pack's margin. */
export const packMargin = (p: Pack) => p.priceVnd - p.costVnd
