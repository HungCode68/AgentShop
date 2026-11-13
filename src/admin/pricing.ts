import type { PlanId } from './api'

/**
 * Pack pricing for the /admin page.
 *
 * The gateway sells the four revidapi credit packs at a fixed price - revid's price + 30.000đ -
 * with no time limit: the customer uses the pack whenever, until the credits run out. There is
 * no more per-day rental length to interpolate, so this file is just the confirmed price table
 * and a rough "how many tokens is a pack worth" estimate for display.
 *
 * Credits per pack (revidapi's own packs):
 *   Starter 1.500 (99.000đ) · Pro 5.000 (279.000đ) · Business 13.000 (679.000đ) · Enterprise 30.000 (1.339.000đ)
 *
 * The token estimate uses Sonnet 5.5's typical real-world coding cost (measured 2026-11-12:
 * ~17 converted tokens per revid credit with revid's automatic caching); Opus 5.5 costs ~2.4×
 * as much, so the same pack gets fewer tokens when used with Opus. It is an estimate - the
 * hard limit is the credit count itself, which the gateway enforces exactly.
 */

export interface Pack {
  id: PlanId
  name: string
  /** revidapi credits the customer may use in total. */
  credits: number
  /** What we buy the pack for (VND). */
  costVnd: number
  /** What we charge the customer (VND). Confirmed 2026-11-12: cost + 30.000đ. */
  priceVnd: number
}

export const PACKS: Pack[] = [
  { id: 'starter', name: 'Starter', credits: 1_500, costVnd: 99_000, priceVnd: 129_000 },
  { id: 'pro', name: 'Pro', credits: 5_000, costVnd: 279_000, priceVnd: 309_000 },
  { id: 'business', name: 'Business', credits: 13_000, costVnd: 679_000, priceVnd: 709_000 },
  { id: 'enterprise', name: 'Enterprise', credits: 30_000, costVnd: 1_339_000, priceVnd: 1_369_000 },
]

/** The free trial: 100k tokens, for a duration in minutes set per key by the admin. */
export const TRIAL = { id: 'trial', name: 'Dùng thử', credits: 0, tokenCap: 100_000, priceVnd: 0, defaultMinutes: 60 }

/** Rough tokens a pack is worth, for the pack list in /admin. An estimate, not a limit. */
export const tokensWorth = (credits: number, opus = false) => Math.round((credits * (opus ? 14_000 : 17_000)) / 1000)

/** Worst case we can ever lose on a pack if the customer uses it all: always the pack's margin. */
export const packMargin = (p: Pack) => p.priceVnd - p.costVnd
