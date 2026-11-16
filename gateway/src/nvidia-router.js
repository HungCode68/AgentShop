/**
 * Which NVIDIA model answers a request, on which key, and what happens when one is rate limited or down.
 *
 * - The Claude model the customer picked chooses the NVIDIA model: Opus → the biggest, Sonnet → the
 *   balanced one, Haiku → the fast one. Requests with images only go to models that see images.
 * - Each model has its own rate limit at NVIDIA, so when the right model is busy or resting the request
 *   moves on to the next model of its chain (and to the next key of the pool) instead of waiting for revid,
 *   which costs full price.
 * - A model or key that fails rests for a while (longer after each repeated failure), so the next requests
 *   do not queue up behind it.
 * Pure bookkeeping, no network: proxy.js does the calling.
 */

export const tierOf = (claudeModel) => (/opus/i.test(claudeModel) ? 'opus' : /haiku/i.test(claudeModel) ? 'haiku' : 'sonnet')

/** The NVIDIA model of each Claude tier; the single `nvidiaModel` fills in for tiers that are not configured. */
export function tierModels(config) {
  const m = config.nvidiaModels ?? {}
  return { opus: m.opus || config.nvidiaModel, sonnet: m.sonnet || config.nvidiaModel, haiku: m.haiku || config.nvidiaModel }
}

/** Which tier to fall back to, closest first. */
const CLOSEST = { opus: ['opus', 'sonnet', 'haiku'], sonnet: ['sonnet', 'opus', 'haiku'], haiku: ['haiku', 'sonnet', 'opus'] }

/** The models to try for a request, best first, without repeats. */
export function modelChain(config, claudeModel, hasImages) {
  const tiers = tierModels(config)
  const chain = [...new Set(CLOSEST[tierOf(claudeModel)].map((t) => tiers[t]).filter(Boolean))]
  if (!hasImages) return chain
  // Only models that see images; the tier's own model first when it is one of them.
  const vision = config.nvidiaVisionModels?.length ? config.nvidiaVisionModels : chain
  return [...vision].sort((a, b) => Number(b === chain[0]) - Number(a === chain[0]))
}

/** rate = 429; server = 5xx or no answer at all (0); auth = the key is rejected; request = this request is the problem. */
export function failureKind(status) {
  if (status === 429) return 'rate'
  if (status === 401 || status === 403) return 'auth'
  if (!status || status >= 500 || status === 408) return 'server'
  return 'request'
}

/** Retry-After header → milliseconds (it is seconds, or a date), undefined when absent or unreadable. */
export function parseRetryAfter(value) {
  if (!value) return undefined
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

const REST_MIN_MS = 10_000
const REST_MAX_MS = 60_000
const REST_RETRY_AFTER_MAX_MS = 120_000
const REST_AUTH_MS = 300_000

export class NvidiaRouter {
  #now
  #maxPerLane
  #inflight = new Map() // "lane|model" → requests running
  #rest = new Map() // "lane|model" or "lane|*" → { failures, until }
  #turn = 0

  /** @param {{now?: () => number, maxPerLane?: number}} opts  maxPerLane: requests at once per key and model */
  constructor({ now = () => Date.now(), maxPerLane = 50 } = {}) {
    this.#now = now
    this.#maxPerLane = maxPerLane
  }

  /** The lanes in the order to try them: the first one changes on every call, so a pool of keys shares the load. */
  rotate(lanes) {
    if (lanes.length < 2) return lanes
    const start = this.#turn++ % lanes.length
    return [...lanes.slice(start), ...lanes.slice(0, start)]
  }

  #restUntil(laneId, model) {
    return Math.max(this.#rest.get(`${laneId}|${model}`)?.until ?? 0, this.#rest.get(`${laneId}|*`)?.until ?? 0)
  }

  /**
   * Takes a slot for the best model/key that is neither resting nor full: the right model on any key before
   * a different model. `skip` holds the "key" of attempts that already failed for this request.
   * @returns {{lane: object, model: string, key: string, release: () => void} | null}
   */
  acquire(chain, lanes, skip = new Set()) {
    const now = this.#now()
    for (const model of chain) {
      for (const lane of lanes) {
        const key = `${lane.id}|${model}`
        if (skip.has(key) || this.#restUntil(lane.id, model) > now) continue
        const running = this.#inflight.get(key) ?? 0
        if (running >= this.#maxPerLane) continue
        this.#inflight.set(key, running + 1)
        let released = false
        const release = () => {
          if (released) return
          released = true
          const n = (this.#inflight.get(key) ?? 1) - 1
          if (n > 0) this.#inflight.set(key, n)
          else this.#inflight.delete(key)
        }
        return { lane, model, key, release }
      }
    }
    return null
  }

  /** The model answered: it is healthy again. */
  success(attempt) {
    this.#rest.delete(attempt.key)
  }

  /**
   * The attempt failed before an answer started. Rests the model (or the whole key when it is rejected).
   * @returns {{kind: string, waitMs: number}}
   */
  failure(attempt, { status = 0, retryAfterMs } = {}) {
    const kind = failureKind(status)
    if (kind === 'request') return { kind, waitMs: 0 }
    const restKey = kind === 'auth' ? `${attempt.lane.id}|*` : attempt.key
    const failures = (this.#rest.get(restKey)?.failures ?? 0) + 1
    const waitMs =
      kind === 'auth'
        ? REST_AUTH_MS
        : retryAfterMs != null
          ? Math.min(REST_RETRY_AFTER_MAX_MS, retryAfterMs)
          : Math.min(REST_MAX_MS, REST_MIN_MS * 2 ** (failures - 1))
    this.#rest.set(restKey, { failures, until: this.#now() + waitMs })
    return { kind, waitMs }
  }
}
