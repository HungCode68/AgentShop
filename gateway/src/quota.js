import { MINUTE_MS, MODEL_RATES, PLANS, planCap } from './plans.js'

/**
 * Per-key usage limits.
 *
 * A **paid pack** is a budget of revidapi credits with no time limit: the customer may use it
 * whenever they like until the credits run out. A request is only sent when the credits it could
 * possibly cost are still available, so a customer can never push the account past the pack that
 * was bought for them:
 *
 *   before sending:  reserve an estimate of the request's worst-case cost
 *                    (input + cache write + cache read at their rates, plus max_tokens of output)
 *   after the answer: charge the real cost and release the unused part of the reservation
 *
 * The **trial** is measured in converted tokens (a cost-neutral unit, see plans.js) and is limited
 * in time: the admin sets how many minutes it lasts. It has no credit budget.
 */

export class QuotaStore {
  #db
  #now

  constructor(db, { now = () => Date.now() } = {}) {
    this.#db = db
    this.#now = now
    // The key_usage table is created by openDb() (db.js), so the CLI can delete rows without a QuotaStore.
  }

  /** Current state of a key's rental. */
  #state(record, now) {
    const plan = PLANS[record.plan]
    const start = Date.parse(record.planStartedAt)
    const row = this.#db.prepare('SELECT * FROM key_usage WHERE key_id = ?').get(record.id)
    const s =
      row && row.plan_started_at === record.planStartedAt
        ? {
            creditsUsed: row.credits_used ?? 0,
            tokensUsed: row.tokens_used ?? 0,
            reserved: row.reserved_credits ?? 0,
            models: parseModels(row.models_used),
          }
        : { creditsUsed: 0, tokensUsed: 0, reserved: 0, models: {} }
    return { plan, start, s }
  }

  #save(record, s) {
    this.#db
      .prepare(
        `INSERT INTO key_usage (key_id, plan_started_at, session_start, session_used, week_index, week_used, balance, balance_at, total_used, credits_used, tokens_used, reserved_credits, models_used, updated_at)
         VALUES (?, ?, NULL, 0, 0, 0, 0, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(key_id) DO UPDATE SET plan_started_at = excluded.plan_started_at,
           credits_used = excluded.credits_used, tokens_used = excluded.tokens_used,
           reserved_credits = excluded.reserved_credits, models_used = excluded.models_used,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.id,
        record.planStartedAt,
        this.#now(),
        s.creditsUsed,
        s.tokensUsed,
        s.reserved,
        JSON.stringify(s.models),
        new Date(this.#now()).toISOString(),
      )
  }

  /**
   * Whether the key may send a request now, and how much of its budget it is holding.
   * @returns {{ok: true} | {ok: false, limit: 'credits'|'tokens'|'expired', retryAt: number|null}}
   */
  check(record) {
    const now = this.#now()
    const { plan, start, s } = this.#state(record, now)
    if (plan.free) {
      // The trial: a token budget and a time limit.
      if (record.planMinutes && now >= start + record.planMinutes * MINUTE_MS) {
        return { ok: false, limit: 'expired', retryAt: null }
      }
      if (s.tokensUsed >= planCap(plan)) return { ok: false, limit: 'tokens', retryAt: null }
      return { ok: true }
    }
    // A paid pack: the credits still available, minus what is reserved by requests in flight.
    if (s.creditsUsed + s.reserved >= planCap(plan)) return { ok: false, limit: 'credits', retryAt: null }
    return { ok: true }
  }

  /**
   * Reserves the worst-case credit cost of a request, so the answer cannot overdraw the pack.
   * The reservation is released by charge() (with the real cost) or by release() (on failure).
   * @returns {{ok: true, reserve: number} | {ok: false, limit: 'credits'}}
   */
  reserve(record, estimate) {
    const now = this.#now()
    const { plan, s } = this.#state(record, now)
    if (plan.free) return { ok: true, reserve: 0 }
    const reserve = Math.max(0, estimate)
    if (s.creditsUsed + s.reserved + reserve > planCap(plan)) return { ok: false, limit: 'credits' }
    s.reserved += reserve
    this.#save(record, s)
    return { ok: true, reserve }
  }

  /** Gives a reservation back without charging anything (the request failed before producing output). */
  release(record, reserve) {
    if (!(reserve > 0)) return
    const { s } = this.#state(record, this.#now())
    s.reserved = Math.max(0, s.reserved - reserve)
    this.#save(record, s)
  }

  /**
   * Charges one answer: its real credit cost, its converted tokens, and its per-model breakdown.
   * The reservation held for this request (by reserve()) is released here.
   *
   * A paid pack is never charged past its credits: if an answer cost more than what was left
   * (revid does not stop at max_tokens), the customer is charged up to the pack and the rest is
   * returned as `absorbed` so the caller can log it - the operator pays that part.
   * @returns {{charged: number, absorbed: number}}
   */
  charge(record, { credits = 0, tokens = 0, model = null, reserved = 0 }) {
    const { plan, s } = this.#state(record, this.#now())
    s.reserved = Math.max(0, s.reserved - reserved)
    let absorbed = 0
    if (!plan.free) {
      const room = Math.max(0, planCap(plan) - s.creditsUsed)
      if (credits > room) {
        absorbed = credits - room
        credits = room
      }
    }
    s.creditsUsed += credits
    s.tokensUsed += tokens
    if (model && (credits > 0 || tokens > 0)) {
      const m = (s.models[model] ??= { tokens: 0, credits: 0 })
      m.tokens += tokens
      m.credits += credits
    }
    this.#save(record, s)
    return { charged: credits, absorbed }
  }

  /** Numbers for the quota page and /admin. */
  snapshot(record) {
    const now = this.#now()
    const { plan, start, s } = this.#state(record, now)
    const free = plan.free
    const cap = planCap(plan)
    // A paid pack is measured in credits, the trial in converted tokens.
    const used = free ? s.tokensUsed : s.creditsUsed
    const expiresAt = free && record.planMinutes ? new Date(start + record.planMinutes * MINUTE_MS).toISOString() : null
    return {
      plan,
      unit: free ? 'token' : 'credit',
      cap,
      used,
      remaining: Math.max(0, cap - used),
      creditsUsed: s.creditsUsed,
      tokensUsed: s.tokensUsed,
      // Credits still available right now, minus what requests in flight have reserved.
      creditsRemaining: free ? null : Math.max(0, cap - s.creditsUsed - s.reserved),
      reserved: s.reserved,
      // Per-model breakdown of what the customer used.
      models: s.models,
      startedAt: new Date(start).toISOString(),
      expiresAt,
      unlimited: !free,
    }
  }

  remove(keyId) {
    this.#db.prepare('DELETE FROM key_usage WHERE key_id = ?').run(keyId)
  }
}

/** The per-model breakdown is stored as JSON in one column. */
function parseModels(raw) {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/**
 * Tokens revid adds to every request on its own (its system prompt, cached on the first call).
 * Measured 2026-11-13: the first call of a burst writes ~10.2k tokens to cache.
 */
export const REVID_OVERHEAD_TOKENS = 10_500
/**
 * revid ignores max_tokens (measured 2026-11-13: max_tokens 20 → 1.518 output tokens), so the
 * output part of a reservation is at least this many tokens.
 */
export const OUTPUT_RESERVE_FLOOR = 4_096

/**
 * The likely worst-case credit cost of a request on `model`, before it runs: every input token
 * (plus revid's own overhead) counted at the cache-write rate, plus the larger of max_tokens and
 * OUTPUT_RESERVE_FLOOR of output. An answer can still cost more (revid does not stop at
 * max_tokens); charge() then caps the customer at their pack, see there.
 */
export function estimateRequestCredits({ model, inputTokens = 0, maxTokens = 0 }) {
  const r = MODEL_RATES[model]
  if (!r) return 0
  const input = Math.max(0, inputTokens) + REVID_OVERHEAD_TOKENS
  const output = Math.max(OUTPUT_RESERVE_FLOOR, Number.isFinite(maxTokens) ? maxTokens : 0)
  return (input * Math.max(r.in, r.write) + output * r.out) / 1e6
}
