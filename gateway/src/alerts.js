import { upstreamBalance } from './admin.js'
import { sendTelegramMessage } from './telegram.js'

/**
 * Low-credit balance alert poller.
 *
 * Revidapi is a shared account: when its credit balance drops to
 * config.telegramLowCredits, the owner gets a Telegram message. Alerts repeat
 * at most every 30 minutes while the balance stays low; a reading back above
 * the threshold resets the rearm timer so the next drop alerts immediately.
 *
 * startBalanceAlerts returns { stop, tick } — the server owns the loop
 * (tick is also driven directly by the tests) and stops it on shutdown.
 */

// An alert for a still-low balance repeats at most every 30 minutes.
const REARM_MS = 30 * 60_000

export function startBalanceAlerts({
  config,
  fetchImpl = fetch,
  log = (line) => console.log(line),
  timer = globalThis, // object with setInterval/clearInterval (globalThis in prod)
  now = Date.now, // function returning ms (tests control the clock)
}) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    log(`${new Date().toISOString()} WARN telegram alerts disabled (thiếu bot token hoặc chat id)`)
    return { stop() {}, tick() {} }
  }
  log(`${new Date().toISOString()} INFO telegram alerts enabled: threshold=${config.telegramLowCredits}, every ${config.telegramAlertIntervalMin} min`)

  let lastAlertAt = null

  /** Vietnamese plain-text message; the "used today" line is only included when the numbers are finite.
   *  Resolves true only when Telegram answered HTTP ok with { ok: true }; false otherwise (never throws). */
  async function sendTelegram(remaining, bal) {
    const threshold = config.telegramLowCredits
    const lines = [
      `⚠️ AgentShop — credit hệ thống còn ${remaining} (ngưỡng ${threshold}).`,
      'Hãy nạp thêm revidapi để tránh gián đoạn.',
    ]
    if (Number.isFinite(bal.creditsUsedToday)) {
      const requests = Number.isFinite(bal.requestsToday) ? ` (${bal.requestsToday} request)` : ''
      lines.splice(1, 0, `Đã dùng hôm nay: ${bal.creditsUsedToday} credit${requests}.`)
    }
    // sendTelegramMessage never throws: a failed send must not take the poller down with it.
    const r = await sendTelegramMessage({ config, fetchImpl, text: lines.join('\n') })
    if (r.ok) {
      log(`${new Date().toISOString()} INFO telegram alert sent, balance=${remaining}`)
      return true
    }
    log(`${new Date().toISOString()} WARN telegram send failed: ${r.error}`)
    return false
  }

  /** One check: read the revidapi balance and alert when it is at/below the threshold. Never throws. */
  async function runOnce() {
    const bal = await upstreamBalance({ config, fetchImpl, log })
    if (!bal.ok || bal.stale) {
      log(`${new Date().toISOString()} WARN revid balance check failed or stale: ${bal.error} — no alert sent`)
      return
    }
    const remaining = bal.creditsRemaining
    const threshold = config.telegramLowCredits
    if (remaining <= threshold) {
      if (lastAlertAt === null || now() - lastAlertAt >= REARM_MS) {
        // Only a delivered alert arms the 30-min re-alert; a failed send is retried next tick.
        if (await sendTelegram(remaining, bal)) lastAlertAt = now()
      }
    } else if (lastAlertAt !== null) {
      log(`${new Date().toISOString()} INFO balance back above threshold (${remaining} > ${threshold}), reset alert`)
      lastAlertAt = null
    }
  }

  // Ticks never overlap: an interval that fires while a check is still reading a slow revidapi
  // queues behind it, so a slow read can't double-send an alert.
  let chain = Promise.resolve()
  function tick() {
    const p = chain
      .then(() => runOnce())
      .catch((e) => log(`${new Date().toISOString()} ERROR alert tick: ${e.message}`))
    chain = p.then(() => {}, () => {})
    return p
  }

  const handle = timer.setInterval(() => {
    tick().catch((e) => log(`${new Date().toISOString()} ERROR alert tick: ${e.message}`))
  }, config.telegramAlertIntervalMin * 60_000)
  tick()

  return {
    stop() {
      timer.clearInterval(handle)
    },
    tick,
  }
}
