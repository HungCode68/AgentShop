export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return res.end()
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

/** Buffers the request body; rejects with 413 once `limit` bytes are exceeded (the rest is drained). */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        tooLarge = true
        chunks.length = 0
      } else if (!tooLarge) {
        chunks.push(chunk)
      }
    })
    req.on('end', () => (tooLarge ? reject(new HttpError(413, 'Request body too large')) : resolve(Buffer.concat(chunks))))
    req.on('error', reject)
    req.on('close', () => {
      if (!req.complete) reject(new HttpError(400, 'Request aborted'))
    })
  })
}

export async function readJson(req, limit = 64 * 1024) {
  const raw = await readBody(req, limit)
  if (!raw.length) return {}
  try {
    const value = JSON.parse(raw.toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new HttpError(400, 'Body must be a JSON object')
  }
}

export function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin
  if (allowedOrigins.includes('*')) {
    res.setHeader('access-control-allow-origin', '*')
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'Origin')
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key, anthropic-version, anthropic-beta')
  res.setHeader('access-control-max-age', '600')
}
