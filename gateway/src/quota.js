import { allowance, PLANS, SESSION_MS, WEEK_MS } from './plans.js'

/**
 * Per-key usage limits for plan customers. Four limits, all in converted tokens (see plans.js):
 *  - session: at most `sessionCap` within 5 hours, starting with the first request after the last session ended
 *  - week:    at most `weeklyCap` per 7-day window counted from the rental start
 *  - rental:  at most allowance(plan, days) over the whole rental, so a short rental cannot use a full week
 *  - balance: spreads use over the week. Starts full at one session's worth, refills by weeklyCap/7 per day,
 *             never holds more than one session. Using it all just means waiting for it to refill.
 * A request is let through while every limit has room; the answer's real usage is charged afterwards
 * (so one request can go slightly over, never more than that).
 */

/** Balance needed before a blocked key may send again, so customers are not let in for a few tokens at a time. */
const RESUME_TOKENS = 5_000

export class QuotaStore {
  #db
  #now

  constructor(db, { now = () => Date.now() } = {}) {
    this.#db = db
    this.#now = now
    // The key_usage table is created by openDb() (db.js), so the CLI can delete rows without a QuotaStore.
  }

  /** Current state of a key's rental, with windows rolled over and the balance refilled up to now. */
  #state(record, now) {
    const plan = PLANS[record.plan]
    const start = Date.parse(record.planStartedAt)
    const row = this.#db.prepare('SELECT * FROM key_usage WHERE key_id = ?').get(record.id)
    const s =
      row && row.plan_started_at === record.planStartedAt
        ? {
            sessionStart: row.session_start,
            sessionUsed: row.session_used,
            weekIndex: row.week_index,
            weekUsed: row.week_used,
            balance: row.balance,
            balanceAt: row.balance_at,
            totalUsed: row.total_used,
          }
        : { sessionStart: null, sessionUsed: 0, weekIndex: 0, weekUsed: 0, balance: plan.sessionCap, balanceAt: start, totalUsed: 0 }

    if (s.sessionStart !== null && now >= s.sessionStart + SESSION_MS) {
      s.sessionStart = null
      s.sessionUsed = 0
    }
    const weekIndex = Math.max(0, Math.floor((now - start) / WEEK_MS))
    if (weekIndex !== s.weekIndex) {
      s.weekIndex = weekIndex
      s.weekUsed = 0
    }
    const rate = plan.weeklyCap / WEEK_MS
    s.balance = Math.min(plan.sessionCap, s.balance + Math.max(0, now - s.balanceAt) * rate)
    s.balanceAt = now
    return { plan, start, rate, s }
  }

  #save(record, s) {
    this.#db
      .prepare(
        `INSERT INTO key_usage (key_id, plan_started_at, session_start, session_used, week_index, week_used, balance, balance_at, total_used, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_id) DO UPDATE SET plan_started_at = excluded.plan_started_at, session_start = excluded.session_start,
           session_used = excluded.session_used, week_index = excluded.week_index, week_used = excluded.week_used,
           balance = excluded.balance, balance_at = excluded.balance_at, total_used = excluded.total_used, updated_at = excluded.updated_at`,
      )
      .run(record.id, record.planStartedAt, s.sessionStart, s.sessionUsed, s.weekIndex, s.weekUsed, s.balance, s.balanceAt, s.totalUsed, new Date(this.#now()).toISOString())
  }

  /**
   * Whether the key may send a request now.
   * @returns {{ok: true} | {ok: false, limit: 'rental'|'week'|'session'|'balance', retryAt: number|null}}
   */
  check(record) {
    const now = this.#now()
    const { plan, start, rate, s } = this.#state(record, now)
    if (s.totalUsed >= allowance(plan, record.planDays)) return { ok: false, limit: 'rental', retryAt: null }
    if (s.weekUsed >= plan.weeklyCap) return { ok: false, limit: 'week', retryAt: start + (s.weekIndex + 1) * WEEK_MS }
    if (s.sessionStart !== null && s.sessionUsed >= plan.sessionCap) return { ok: false, limit: 'session', retryAt: s.sessionStart + SESSION_MS }
    if (s.balance <= 0) return { ok: false, limit: 'balance', retryAt: now + Math.ceil((RESUME_TOKENS - s.balance) / rate) }
    return { ok: true }
  }

  /** Charges the converted tokens of one answer. The first charge after a session ended starts a new one. */
  charge(record, tokens) {
    if (!(tokens > 0)) return
    const now = this.#now()
    const { s } = this.#state(record, now)
    if (s.sessionStart === null) s.sessionStart = now
    s.sessionUsed += tokens
    s.weekUsed += tokens
    s.balance -= tokens
    s.totalUsed += tokens
    this.#save(record, s)
  }

  /** Numbers for the quota page and /admin. */
  snapshot(record) {
    const now = this.#now()
    const { plan, start, s } = this.#state(record, now)
    const rentalCap = allowance(plan, record.planDays)
    const available = Math.max(0, Math.min(s.balance, plan.sessionCap - (s.sessionStart === null ? 0 : s.sessionUsed), plan.weeklyCap - s.weekUsed, rentalCap - s.totalUsed))
    return {
      plan,
      sessionUsed: s.sessionStart === null ? 0 : s.sessionUsed,
      sessionEnd: s.sessionStart === null ? null : new Date(s.sessionStart + SESSION_MS).toISOString(),
      weekUsed: s.weekUsed,
      weekEnd: new Date(start + (s.weekIndex + 1) * WEEK_MS).toISOString(),
      totalUsed: s.totalUsed,
      rentalCap,
      available,
      dailyRefill: plan.weeklyCap / 7,
    }
  }

  remove(keyId) {
    this.#db.prepare('DELETE FROM key_usage WHERE key_id = ?').run(keyId)
  }
}
