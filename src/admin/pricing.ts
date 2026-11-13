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
  'claude-sonnet-5-5': { in: 129, write: 215.1, read: 15.1, out: 645.2 },
  'claude-opus-5-5': { in: 301.1, write: 501.8, read: 53.8, out: 1505.4 },
  'claude-haiku-5-5': { in: 64.9, write: 81.2, read: 7.4, out: 324.6 },
}
export const MODEL_LABELS: Record<ModelId, string> = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
}

/**
 * Usage profiles for the token estimate, matching how revid estimates its own packs
 * (revidapi.com/articles/bang-gia-api-ai-vi, read 2026-11-13):
 *  - code: Claude Code / agents - context resent each turn, the repeated part read from cache.
 *    A mix of 8 cache-read : 1 cache-write : 1 output reproduces revid's published Opus 5.5
 *    figures (6,3M / 21M / 55M / 126M) within ~3%.
 *  - chat: each question sent on its own, no cache - "~1.000 token vào và ~500 token ra".
 * Tokens are what the client itself counts (cache included).
 */
export type UsageProfile = 'code' | 'chat'
export const PROFILES: Record<UsageProfile, { label: string; input: number; cacheRead: number; cacheWrite: number; output: number }> = {
  code: { label: 'Code / Claude Code', input: 0, cacheRead: 16_000, cacheWrite: 2_000, output: 2_000 },
  chat: { label: 'Chat thường', input: 1_000, cacheRead: 0, cacheWrite: 0, output: 500 },
}

/** Tokens one credit buys on `model` for a usage profile. */
export function tokensPerCredit(model: ModelId, profile: UsageProfile = 'code'): number {
  const r = MODEL_RATES[model]
  const t = PROFILES[profile]
  const credits = (t.input * r.in + t.cacheRead * r.read + t.cacheWrite * r.write + t.output * r.out) / 1e6
  return (t.input + t.cacheRead + t.cacheWrite + t.output) / credits
}

/** Rough tokens a pack is worth. An estimate for display; the credit count is the real limit. */
export const tokensWorth = (credits: number, model: ModelId = 'claude-sonnet-5-5', profile: UsageProfile = 'code') =>
  credits * tokensPerCredit(model, profile)

/** Short token count: "25,4M", "1,2 tỷ". */
export function fmtTokenCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ`
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}M`
  return `${Math.round(n / 1000).toLocaleString('vi-VN')}k`
}

/** Worst case we can ever lose on a pack if the customer uses it all: always the pack's margin. */
export const packMargin = (p: Pack) => p.priceVnd - p.costVnd
