/**
 * Plan pricing math for the /admin price calculator.
 *
 * Units: limits are in "converted tokens" (output = 1, input / cache write = 0.36,
 * cache read = 0.036, at Sonnet prices; Opus 5.5 counts x2.4, Opus 5 x3, Haiku x0.51 — measured on revidapi,
 * see gateway/src/plans.js), so a plan's cost ceiling does not depend on how a customer mixes
 * input and output.
 *
 *   allowance(d)   = max(sessionCap, weeklyCap * d / 7)              tokens a d-day rental may use
 *   unitCost       = creditPrice * creditsPerMTok / 1e6                VND per converted token
 *   maxCost(d)     = allowance(d) * unitCost                           cost if the customer uses it all
 *   price(d)       = linear interpolation between the anchor prices
 *                    (beyond the last anchor: its per-day price * d)
 *   worstProfit    = price - maxCost
 *   typicalProfit  = price - maxCost * typicalUsage
 *   floorPrice(d)  = maxCost(d) * (1 + minMargin), rounded up to 1.000đ
 */

export interface Plan {
  id: string
  name: string
  /** Max converted tokens in one 5-hour session. */
  sessionCap: number
  /** Max converted tokens per 7 days. */
  weeklyCap: number
  /** Confirmed prices (VND) by rental length in days. */
  anchors: { days: number; price: number }[]
}

export interface PricingSettings {
  /** VND per revidapi credit (depends on the credit pack bought). */
  creditPrice: number
  /** revidapi credits per 1M converted tokens (Sonnet output price: 42.583đ at 66đ/credit ≈ 645). */
  creditsPerMTok: number
  /** Share of the allowance a typical customer uses (0..1). */
  typicalUsage: number
  /** Margin used for the floor price (0..1). */
  minMargin: number
}

export const CREDIT_PACKS = [
  { id: 'starter', label: 'Starter (66đ/credit)', price: 66 },
  { id: 'pro', label: 'Pro (55,8đ/credit)', price: 55.8 },
  { id: 'business', label: 'Business (52,2đ/credit)', price: 52.2 },
  { id: 'enterprise', label: 'Enterprise (44,6đ/credit)', price: 44.6 },
] as const

export const DEFAULT_SETTINGS: PricingSettings = {
  creditPrice: 55.8,
  creditsPerMTok: 645,
  typicalUsage: 0.3,
  minMargin: 0.05,
}

/** Plans confirmed with the operator on 2026-11-12. */
export const DEFAULT_PLANS: Plan[] = [
  {
    id: 'pro',
    name: 'Pro',
    sessionCap: 800_000,
    weeklyCap: 2_500_000,
    anchors: [
      { days: 1, price: 40_000 },
      { days: 7, price: 100_000 },
      { days: 30, price: 400_000 },
    ],
  },
  {
    id: 'max5x',
    name: 'Max 5x',
    sessionCap: 2_500_000,
    weeklyCap: 10_000_000,
    anchors: [
      { days: 1, price: 110_000 },
      { days: 7, price: 380_000 },
      { days: 30, price: 1_550_000 },
    ],
  },
  {
    id: 'max20x',
    name: 'Max 20x',
    sessionCap: 7_500_000,
    weeklyCap: 20_000_000,
    anchors: [
      { days: 1, price: 300_000 },
      { days: 7, price: 740_000 },
      { days: 30, price: 3_000_000 },
    ],
  },
]

export const unitCost = (s: PricingSettings) => (s.creditPrice * s.creditsPerMTok) / 1e6

export const allowance = (plan: Plan, days: number) => Math.max(plan.sessionCap, (plan.weeklyCap * days) / 7)

export const maxCost = (plan: Plan, days: number, s: PricingSettings) => allowance(plan, days) * unitCost(s)

const roundTo = (v: number, step: number) => Math.round(v / step) * step
const ceilTo = (v: number, step: number) => Math.ceil(v / step) * step

/** Price for any rental length, interpolated from the plan's anchor prices, rounded to 1.000đ. */
export function interpolatedPrice(plan: Plan, days: number): number {
  const a = [...plan.anchors].filter((x) => x.days > 0 && x.price >= 0).sort((x, y) => x.days - y.days)
  if (!a.length) return 0
  if (days <= a[0].days) return roundTo((a[0].price / a[0].days) * days, 1000)
  for (let i = 1; i < a.length; i++) {
    if (days <= a[i].days) {
      const t = (days - a[i - 1].days) / (a[i].days - a[i - 1].days)
      return roundTo(a[i - 1].price + t * (a[i].price - a[i - 1].price), 1000)
    }
  }
  const last = a[a.length - 1]
  return roundTo((last.price / last.days) * days, 1000)
}

export const floorPrice = (plan: Plan, days: number, s: PricingSettings) => ceilTo(maxCost(plan, days, s) * (1 + s.minMargin), 1000)

export interface Quote {
  days: number
  allowance: number
  maxCost: number
  price: number
  floor: number
  worstProfit: number
  typicalProfit: number
  /** worstProfit / price, or 0 when price is 0. */
  worstMargin: number
  pricePerDay: number
}

/** Everything the calculator shows for one plan and rental length. `price` overrides the interpolated one. */
export function quote(plan: Plan, days: number, s: PricingSettings, price?: number): Quote {
  const cost = maxCost(plan, days, s)
  const p = price ?? interpolatedPrice(plan, days)
  return {
    days,
    allowance: allowance(plan, days),
    maxCost: cost,
    price: p,
    floor: floorPrice(plan, days, s),
    worstProfit: p - cost,
    typicalProfit: p - cost * s.typicalUsage,
    worstMargin: p > 0 ? (p - cost) / p : 0,
    pricePerDay: p / days,
  }
}
