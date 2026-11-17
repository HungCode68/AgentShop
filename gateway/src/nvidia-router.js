/**
 * Which NVIDIA model answers a request, on which key, and what happens when one is rate limited or down.
 *
 * - The task decides the model, not the Claude model the customer picked: everyday questions go to the fast
 *   models, anything with an image to the models that can see, and code, agent work (tools, commands, tests)
 *   and heavy analysis to the strong ones. Each kind of task has its own chain of models, best first.
 * - Each model has its own rate limit at NVIDIA, so when the best model is busy or resting the request
 *   moves on to the next model of its chain (and to the next key of the pool) instead of waiting for revid,
 *   which costs full price.
 * - A model or key that fails rests for a while (longer after each repeated failure), so the next requests
 *   do not queue up behind it.
 * Pure bookkeeping, no network: proxy.js does the calling.
 */
import { hasImages } from './nvidia.js'

/* ------------------------------------------------------------------ what kind of task is it? */

/** Claude Code adds reminders and IDE notes to the customer's message; they are not what the customer asked. */
const NOISE_TAGS = /<(system-reminder|ide_[a-z_]+|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g

/** Lowercase, no accents ("Viết hàm" and "viet ham" read the same). */
const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')

/**
 * Words that mean a programming, technical or analysis request (English, and Vietnamese without accents).
 * Meant to be a little eager: a casual chat that lands on the strong model only costs some speed, a code
 * task that lands on the fast one costs quality.
 */
const TECH_WORDS = [
  'code', 'coding', 'function', 'class', 'method', 'variable', 'bug', 'bugs', 'debug', 'error', 'exception', 'stack trace', 'traceback',
  'compile', 'compiler', 'refactor', 'implement', 'algorithm', 'regex', 'sql', 'database', 'query', 'script', 'api', 'endpoint', 'deploy',
  'docker', 'kubernetes', 'git', 'commit', 'unit test', 'test', 'tests', 'typescript', 'javascript', 'python', 'java', 'golang', 'rust',
  'html', 'css', 'react', 'npm', 'pip', 'terminal', 'shell', 'bash', 'powershell', 'backend', 'frontend', 'json', 'yaml', 'http', 'ssh',
  'linux', 'repository', 'analyze', 'analyse', 'analysis', 'architecture',
  // Working on the customer's machine or project: files, folders, a repository, the browser
  'file', 'folder', 'directory', 'project', 'repo', 'pull request', 'readme', 'framework', 'library', 'browser', 'chrome',
  'viet code', 'lap trinh', 'viet ham', 'sua loi', 'bi loi', 'bao loi', 'thuat toan', 'chay lenh', 'cau lenh', 'cai dat', 'trien khai',
  'toi uu', 'kiem thu', 'viet test', 'phan tich', 'kien truc', 'co so du lieu', 'ma nguon', 'doan ma',
  'du an', 'thu muc', 'tep tin', 'trinh duyet', 'tao file', 'xoa file', 'doc file', 'ghi file',
]
const TECH_RE = new RegExp(`(?:^|[^a-z0-9])(?:${TECH_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|')})(?![a-z0-9])`)
/** A fenced block of code, a stack trace, or the name of a source file. */
const CODE_SHAPE_RE = /```|\n\s+at\s.+\(.+:\d+:\d+\)|\b[\w-]+\.(?:py|js|ts|tsx|jsx|java|go|rs|cpp|cs|php|rb|sql|sh|ya?ml)\b/i

/** The customer's latest message, as plain text without the client's own notes. */
function latestAsk(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user') continue
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
    const text = blocks
      .filter((b) => b?.type === 'text')
      .map((b) => String(b.text ?? '').replace(NOISE_TAGS, ''))
      .join('\n')
      .trim()
    if (text) return text.slice(0, 20_000)
  }
  return ''
}

const usedTools = (messages) => messages.some((m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'tool_use' || b?.type === 'tool_result'))

/**
 * What kind of task a request is, from the request alone (no extra model call, so no extra delay or cost).
 * @returns {{kind: 'chat' | 'agent' | 'vision', reason: string}}
 *   chat = everyday question, fast models · agent = code, tools, analysis, long or careful work, strong models ·
 *   vision = there is an image in the conversation, models that can see
 */
export function classifyTask(request, { inputEstimate = 0, longContextTokens = 20_000, routing = true } = {}) {
  if (hasImages(request)) return { kind: 'vision', reason: 'image in the conversation' }
  if (!routing) return { kind: 'agent', reason: 'task routing is off' }
  if (request.thinking?.type === 'enabled' || request.thinking?.type === 'adaptive') return { kind: 'agent', reason: 'extended thinking' }
  if (request.tool_choice?.type === 'tool' || request.tool_choice?.type === 'any' || request.output_config?.format || request.output_format) {
    return { kind: 'agent', reason: 'forced tool or structured output' }
  }
  const messages = Array.isArray(request.messages) ? request.messages : []
  if (usedTools(messages)) return { kind: 'agent', reason: 'tools used in this conversation' }
  if (inputEstimate >= longContextTokens) return { kind: 'agent', reason: 'long conversation' }
  const ask = latestAsk(messages)
  if (CODE_SHAPE_RE.test(ask) || TECH_RE.test(plain(ask))) return { kind: 'agent', reason: 'code or technical request' }
  return { kind: 'chat', reason: 'plain chat' }
}

/* ------------------------------------------------------------------ which models, in which order */

/** The models to try for a kind of task, best first, without repeats. Falls back to the single nvidiaModel. */
export function modelChain(config, kind) {
  const chain = config.nvidiaChains?.[kind]
  return [...new Set((chain?.length ? chain : [config.nvidiaModel]).filter(Boolean))]
}

/** Every model the gateway may use, once (for the connection test). */
export function allModels(config) {
  return [...new Set(['chat', 'agent', 'vision'].flatMap((k) => modelChain(config, k)))]
}

/* ------------------------------------------------------------------ when a model fails */

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
