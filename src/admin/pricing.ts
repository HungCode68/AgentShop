import { PACKS as PUBLIC_PACKS, FREE_TRIAL, type PublicPack } from '../lib/packs'

/**
 * Pack pricing for the /admin page: the public pack list (src/lib/packs.ts) plus what each pack
 * costs us. Costs stay in this admin-only module so the public /bang-gia page never ships them.
 *
 * Costs are revid's own packs: Starter 1.500 (99.000đ) · Pro 5.000 (279.000đ) ·
 * Business 13.000 (679.000đ) · Enterprise 30.000 (1.339.000đ). Mini (500 credit) has no revid pack
 * of its own; its cost is 500 credits at revid's Starter rate (66đ/credit), the dearest case.
 */
export {
  fmtTokenCount,
  MODEL_LABELS,
  MODEL_RATES,
  PROFILES,
  tokensPerCredit,
  tokensWorth,
  type ModelId,
  type UsageProfile,
} from '../lib/packs'

const COST_VND: Record<PublicPack['id'], number> = {
  mini: 33_000,
  starter: 99_000,
  pro: 279_000,
  business: 679_000,
  enterprise: 1_339_000,
}

export interface Pack extends PublicPack {
  /** What we buy the pack for (VND). */
  costVnd: number
}

export const PACKS: Pack[] = PUBLIC_PACKS.map((p) => ({ ...p, costVnd: COST_VND[p.id] }))

/** The free trial: 100k tokens, for a duration in minutes set per key by the admin. */
export const TRIAL = { id: 'trial' as const, name: FREE_TRIAL.name, credits: 0, tokenCap: FREE_TRIAL.tokenCap, priceVnd: 0, defaultMinutes: FREE_TRIAL.defaultMinutes }

/** What we earn on a pack if the customer uses it all: always the pack's margin. */
export const packMargin = (p: Pack) => p.priceVnd - p.costVnd
