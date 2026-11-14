/**
 * Sends one plain-text message through the Telegram Bot API (sendMessage) to config.telegramChatId.
 * Shared by the low-credit alert poller and the admin "send a test message" button.
 *
 * Resolves { ok: true } only when Telegram answered HTTP ok with { ok: true }; otherwise
 * { ok: false, error } (never throws). The error carries Telegram's own description
 * ("Unauthorized", "chat not found", …) — never the bot token.
 */
export async function sendTelegramMessage({ config, fetchImpl = fetch, text }) {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return { ok: false, error: 'Chưa cấu hình TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.' }
  }
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text }),
      signal: AbortSignal.timeout(10_000),
    })
    let j = null
    try { j = await res?.json() } catch { /* body not JSON */ }
    if (res?.ok && j?.ok === true) return { ok: true }
    const detail = typeof j?.description === 'string' ? `: ${j.description}` : ''
    return { ok: false, error: `HTTP ${res?.status ?? 'unknown'}${detail}` }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}
