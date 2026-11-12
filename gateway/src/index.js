import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { KeyStore } from './keys.js'
import { QuotaStore } from './quota.js'
import { createGateway } from './server.js'

let config
try {
  config = loadConfig()
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const db = openDb(config.dbPath)
const store = new KeyStore(db, config)
const quota = new QuotaStore(db)
const server = createGateway({ config, store, quota })

// Long AI responses can stream for minutes; only the header phase is time-limited.
server.requestTimeout = 0
server.headersTimeout = 60_000

server.listen(config.port, () => {
  console.log(`Gateway listening on :${config.port} → ${config.revidBaseUrl} (db: ${config.dbPath})`)
})

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down…`)
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
