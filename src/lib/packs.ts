/**
 * Public pack data and usage estimates: what customers see on /bang-gia (and what /admin builds on).
 * Never put purchase costs or margins here - this module is part of the public bundle.
 * Keep credits/prices in sync with gateway/src/plans.js (PLANS) and rates with MODEL_RATES there.
 */

export type PackId = 'mini' | 'starter' | 'pro' | 'business' | 'enterprise'
export type ModelId = 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'claude-haiku-5-5'

export interface PublicPack {
  id: PackId
  name: string
  /** revid credits the customer may use in total, with no time limit. */
  credits: number
  priceVnd: number
  /** Who the pack is for, one short line. */
  tagline: string
}

export const PACKS: PublicPack[] = [
  { id: 'mini', name: 'Mini', credits: 500, priceVnd: 40_000, tagline: 'Trải nghiệm, dùng thử vài buổi' },
  { id: 'starter', name: 'Starter', credits: 1_500, priceVnd: 130_000, tagline: 'Cá nhân, dùng nhẹ hằng tuần' },
  { id: 'pro', name: 'Pro', credits: 5_000, priceVnd: 300_000, tagline: 'Code và làm việc hằng ngày' },
  { id: 'business', name: 'Business', credits: 13_000, priceVnd: 700_000, tagline: 'Dùng nhiều, nhóm nhỏ' },
  { id: 'enterprise', name: 'Enterprise', credits: 30_000, priceVnd: 1_400_000, tagline: 'Nhóm, dùng liên tục' },
]
/** The pack highlighted as the usual choice. */
export const POPULAR_PACK: PackId = 'pro'

/** The free trial the admin can hand out: 100k converted tokens for a number of minutes. */
export const FREE_TRIAL = { name: 'Dùng thử', tokenCap: 100_000, defaultMinutes: 60 }

/**
 * What revid bills, in credits per 1M tokens (in/out published by revid, cache write/read
 * measured 2026-11-13 - see gateway/src/plans.js). Charged exactly by the gateway.
 */
export const MODEL_RATES: Record<ModelId, { in: number; write: number; read: number; out: number }> = {
  'claude-sonnet-5-5': { in: 129, write: 215.1, read: 15.1, out: 645.2 },
  'claude-opus-5-5': { in: 301.1, write: 501.8, read: 53.8, out: 1505.4 },
  'claude-haiku-5-5': { in: 64.9, write: 81.2, read: 7.4, out: 324.6 },
}
export const MODELS = Object.keys(MODEL_RATES) as ModelId[]
export const MODEL_LABELS: Record<ModelId, string> = {
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
}

/** Token mix of one request: fresh input, cache writes, cache reads, output. */
export interface TokenMix {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

export const mixTokens = (m: TokenMix) => m.input + m.cacheWrite + m.cacheRead + m.output
export const mixCredits = (m: TokenMix, model: ModelId) => {
  const r = MODEL_RATES[model]
  return (m.input * r.in + m.cacheWrite * r.write + m.cacheRead * r.read + m.output * r.out) / 1e6
}

/**
 * Token profiles in the same way revid estimates its own packs
 * (revidapi.com/articles/bang-gia-api-ai-vi): code = context resent each turn and read from
 * cache (8 read : 1 write : 1 output, reproduces revid's Opus 5.5 figures within ~3%);
 * chat = each question on its own, ~1.000 tokens in and ~500 out.
 */
export type UsageProfile = 'code' | 'chat'
export const PROFILES: Record<UsageProfile, TokenMix & { label: string }> = {
  code: { label: 'Code / Claude Code', input: 0, cacheRead: 16_000, cacheWrite: 2_000, output: 2_000 },
  chat: { label: 'Chat thường', input: 1_000, cacheRead: 0, cacheWrite: 0, output: 500 },
}

/** Tokens one credit buys on `model` for a profile (all token kinds counted, cache included). */
export const tokensPerCredit = (model: ModelId, profile: UsageProfile = 'code') => mixTokens(PROFILES[profile]) / mixCredits(PROFILES[profile], model)
/** Rough tokens a pack is worth. An estimate; the credit count is the real limit. */
export const tokensWorth = (credits: number, model: ModelId = 'claude-sonnet-5-5', profile: UsageProfile = 'code') => credits * tokensPerCredit(model, profile)

/**
 * revid adds its own prompt to every request and caches it (measured 2026-11-13: ~1.900 tokens
 * written and ~8.400 read on a repeated call). Every task below includes it, which is why even a
 * one-line question costs about one Sonnet credit.
 */
export const REVID_OVERHEAD: TokenMix = { input: 0, cacheWrite: 1_900, cacheRead: 8_400, output: 0 }

export interface Task {
  id: string
  title: string
  /** What one unit of this task looks like, for the customer. */
  example: string
  /** The unit the count is in ("câu hỏi", "lượt"…). */
  unit: string
  mix: TokenMix
}

const plus = (a: TokenMix, b: TokenMix): TokenMix => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
})

/** Typical jobs, per request, revid's overhead included. Estimates for a customer to plan with. */
export const TASKS: Task[] = [
  {
    id: 'chat',
    title: 'Hỏi đáp, chat ngắn',
    example: 'Hỏi một câu, nhận câu trả lời vài đoạn (Chatbox).',
    unit: 'câu hỏi',
    mix: plus(REVID_OVERHEAD, { input: 1_000, cacheWrite: 0, cacheRead: 0, output: 500 }),
  },
  {
    id: 'write',
    title: 'Viết bài, dịch, soạn email',
    example: 'Nhờ viết hoặc dịch một bài khoảng 1–2 trang.',
    unit: 'bài',
    mix: plus(REVID_OVERHEAD, { input: 2_000, cacheWrite: 0, cacheRead: 0, output: 2_000 }),
  },
  {
    id: 'doc',
    title: 'Đọc và tóm tắt tài liệu',
    example: 'Gửi một tài liệu khoảng 20 trang, nhận bản tóm tắt.',
    unit: 'tài liệu',
    mix: plus(REVID_OVERHEAD, { input: 0, cacheWrite: 15_000, cacheRead: 0, output: 1_000 }),
  },
  {
    id: 'code',
    title: 'Code với Claude Code',
    example: 'Mỗi lượt Claude đọc lại ngữ cảnh (~50k token, phần lớn từ cache), sửa code, trả lời. Một việc nhỏ thường 10–30 lượt.',
    unit: 'lượt',
    // The context (revid's overhead included) is read from cache; a little is new each turn.
    mix: { input: 0, cacheWrite: 3_000, cacheRead: 50_000, output: 1_500 },
  },
]

/** How many of `task` a pack covers on `model`. */
export const tasksPerPack = (credits: number, task: Task, model: ModelId) => credits / mixCredits(task.mix, model)

/** Round an estimate to something that reads as an estimate: 1.234 → 1.200, 87 → 85, 3.6 → 3,5. */
export function roundEstimate(n: number): number {
  if (n >= 1000) return Math.round(n / 100) * 100
  if (n >= 100) return Math.round(n / 10) * 10
  if (n >= 20) return Math.round(n / 5) * 5
  return Math.round(n * 2) / 2
}

/** Short token count: "25,4M", "1,2 tỷ", "850k". */
export function fmtTokenCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tỷ`
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}M`
  return `${Math.round(n / 1000).toLocaleString('vi-VN')}k`
}

export const fmtVnd = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`
