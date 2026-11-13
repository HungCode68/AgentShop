/**
 * Customer plans and cost accounting for the revidapi upstream.
 *
 * Customers are billed in **revidapi credits** - the upstream's own unit - so a plan's cost
 * ceiling is exactly the credit pack the operator bought for that customer. A pack is a fixed
 * credit budget with no expiry: the customer may use it whenever, until the credits run out.
 *
 * The credit cost of one answer is computed from revidapi's published per-model rates
 * (GET /v1/models, "credits_in_per_m" / "credits_out_per_m" / "credits_cache_per_m"):
 *   credits = input x in + cache write x write + cache read x read + output x out   (per 1M tokens)
 * revid caches every request automatically, so most input arrives as cache writes or reads.
 *
 * The trial is the exception: it is free and measured in **converted tokens** (a cost-neutral
 * unit, output = 1, input/cache write = 0.36, cache read = 0.036) so its cap does not move
 * with the credit prices. It also has a time limit, set in minutes by the admin.
 *
 * Keep in sync with src/admin/pricing.ts (the /admin price calculator).
 */

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS
export const MINUTE_MS = 60_000
export const SESSION_MS = 5 * HOUR_MS
export const WEEK_MS = 7 * DAY_MS

/**
 * What revid really bills, in credits per 1M tokens.
 *   in, out = published by GET /v1/models ("credits_in_per_m", "credits_out_per_m"), read 2026-11-13
 *   write, read = measured 2026-11-13 against revid's /v1/usage (cache-heavy and cache-write-heavy
 *                 batches per model). revid does not publish a cache-write rate; it is 1.667 x input
 *                 for Sonnet and Opus, 1.25 x input for Haiku. Cache reads match the published
 *                 "credits_cache_per_m" for Opus and Haiku; Sonnet measured 15.1 (published 26.9).
 * Re-measure before changing these: the gateway charges customers exactly this.
 */
export const MODEL_RATES = {
  'claude-sonnet-5-5': { in: 129, write: 215.1, read: 15.1, out: 645.2 },
  'claude-opus-5-5': { in: 301.1, write: 501.8, read: 53.8, out: 1505.4 },
  'claude-haiku-5-5': { in: 64.9, write: 81.2, read: 7.4, out: 324.6 },
}

/** The only models customers may use. Anything else is refused with a 400. */
export const ALLOWED_MODELS = Object.keys(MODEL_RATES)

/** Weight of each token kind relative to an output token, for the free trial's token cap. */
export const TOKEN_WEIGHTS = { input: 0.36, cacheWrite: 0.36, cacheRead: 0.036, output: 1 }

/**
 * Model ids customers may use that we charge for. Fresh installs pin these; dated suffixes
 * ("claude-sonnet-5-5-20260101") and the older haiku 4.5 id (old install scripts pinned it)
 * are normalised onto them, so existing setups keep working. Anything else is refused.
 */
export const MODEL_ALIASES = {
  'claude-haiku-4-5': 'claude-haiku-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-opus-5': 'claude-opus-5-5',
}

/** Accept ids with a dated suffix ("…-20251001") or the older model ids above. */
export const normalizeModel = (m) =>
  MODEL_ALIASES[typeof m === 'string' ? m.trim().replace(/-\d{8}$/, '') : m] ?? m

/**
 * The packs we sell. `credits` is what the customer may spend in total; `price` is what we
 * charge them (confirmed 2026-11-13: 130k / 300k / 700k / 1.400k).
 * A paid pack has no time limit: "use it whenever, until the credits run out".
 */
export const PLANS = {
  trial: {
    id: 'trial',
    name: 'Dùng thử',
    free: true,
    credits: 0,
    // The trial's cap is in converted tokens, not credits (see the file header).
    tokenCap: 100_000,
    price: 0,
    // Default trial length in minutes; the admin can set another one per key.
    defaultMinutes: 60,
  },
  starter: { id: 'starter', name: 'Starter', free: false, credits: 1_500, tokenCap: null, price: 130_000 },
  pro: { id: 'pro', name: 'Pro', free: false, credits: 5_000, tokenCap: null, price: 300_000 },
  business: { id: 'business', name: 'Business', free: false, credits: 13_000, tokenCap: null, price: 700_000 },
  enterprise: { id: 'enterprise', name: 'Enterprise', free: false, credits: 30_000, tokenCap: null, price: 1_400_000 },
}
export const PLAN_IDS = Object.keys(PLANS)

/** The paid packs, in order (the trial is handled separately). */
export const PAID_PLAN_IDS = PLAN_IDS.filter((id) => !PLANS[id].free)

/**
 * Converted tokens for one answer's usage block (Anthropic shape). Used for the trial's
 * token cap and to tell the customer roughly how many tokens a credit is worth.
 */
export function convertedTokens(usage) {
  const u = usage ?? {}
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0)
  const raw =
    n(u.input_tokens) * TOKEN_WEIGHTS.input +
    n(u.cache_creation_input_tokens) * TOKEN_WEIGHTS.cacheWrite +
    n(u.cache_read_input_tokens) * TOKEN_WEIGHTS.cacheRead +
    n(u.output_tokens) * TOKEN_WEIGHTS.output
  return Math.ceil(raw)
}

/**
 * Credits one answer costs on `model`, from revidapi's published rates.
 * Returns 0 for a model we do not price (refused earlier anyway).
 */
export function creditsForUsage(usage, model) {
  const r = MODEL_RATES[model]
  if (!r) return 0
  const u = usage ?? {}
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0)
  const credits =
    n(u.input_tokens) * r.in +
    n(u.cache_creation_input_tokens) * r.write +
    n(u.cache_read_input_tokens) * r.read +
    n(u.output_tokens) * r.out
  return credits / 1e6
}

/**
 * The cap of a plan, in the unit the plan is measured in.
 * A paid plan is measured in credits; the trial in converted tokens.
 */
export function planCap(plan) {
  return plan.free ? plan.tokenCap : plan.credits
}
