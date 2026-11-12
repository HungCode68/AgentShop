// Key management from the server shell, e.g.:
//   docker exec quota-gateway node src/cli.js create --name "Khách A" --plan pro --days 30
import { rmSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { KeyStore, StoreError } from './keys.js'

const USAGE = `Cách dùng: node src/cli.js <lệnh> [tham số]

  list                                         Liệt kê key
  show <id>                                    Xem chi tiết key
  create --name <tên> --plan <pro|max5x|max20x> --days <số ngày>
         [--note <ghi chú>]                    Tạo key mới với gói thuê và in ra key
  plan <id> <pro|max5x|max20x|none> [số ngày]  Gán gói / gia hạn: bắt đầu thời gian thuê mới từ bây giờ
                                               (hạn mức dùng tính lại từ 0, hạn dùng = bây giờ + số ngày)
  expires <id> <ngày ISO|never>                Đặt hạn dùng, vd 2026-12-31 hoặc 2026-12-31T23:59:59+07:00
  rename <id> <tên>                            Đổi tên
  revoke <id>                                  Thu hồi key
  activate <id>                                Kích hoạt lại key đã thu hồi
  reveal <id>                                  In lại key đầy đủ của khách
  rotate <id>                                  Cấp key mới cho cùng bản ghi (key cũ ngừng hoạt động)
  delete <id>                                  Xoá key
  backup <file>                                Sao lưu database ra file (ghi đè nếu đã có)`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    plan: { type: 'string' },
    days: { type: 'string' },
    expires: { type: 'string' },
    note: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

const [command, ...args] = positionals
if (!command || values.help) {
  console.log(USAGE)
  process.exit(command ? 0 : 1)
}

let db, store
try {
  const config = loadConfig(process.env, { requireAdminToken: false })
  db = openDb(config.dbPath)
  store = new KeyStore(db, config)
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const id = () => {
  const n = Number(args[0])
  if (!Number.isSafeInteger(n)) fail('Thiếu hoặc sai <id>')
  return n
}
const arg = (i, label) => args[i] ?? fail(`Thiếu ${label}`)
function fail(msg) {
  console.error(`Lỗi: ${msg}\n\n${USAGE}`)
  process.exit(1)
}
const printRecord = (r) => console.log(JSON.stringify(r, null, 2))
const printNewKey = ({ key, record }) => {
  printRecord(record)
  console.log(`\nKEY: ${key}\n(In lại bất cứ lúc nào bằng: reveal ${record.id})`)
}

try {
  switch (command) {
    case 'list':
      console.table(
        store.list().map((k) => ({
          id: k.id,
          name: k.name,
          key: k.keyPrefix,
          plan: k.planName ? `${k.planName} ${k.planDays}d` : '-',
          status: k.effectiveStatus,
          expiresAt: k.expiresAt ?? 'never',
          lastUsedAt: k.lastUsedAt ?? '-',
          requests: k.requestCount,
        })),
      )
      break
    case 'show':
      printRecord(store.get(id()))
      break
    case 'create':
      printNewKey(store.create({ name: values.name, plan: values.plan, planDays: values.days, note: values.note }))
      break
    case 'plan': {
      const value = arg(1, '<pro|max5x|max20x|none>')
      printRecord(store.update(id(), value === 'none' ? { plan: null } : { plan: value, planDays: args[2] }))
      break
    }
    case 'expires':
      printRecord(store.update(id(), { expiresAt: arg(1, '<ngày|never>') }))
      break
    case 'rename':
      printRecord(store.update(id(), { name: args.slice(1).join(' ') || fail('Thiếu <tên>') }))
      break
    case 'revoke':
      printRecord(store.update(id(), { status: 'revoked' }))
      break
    case 'activate':
      printRecord(store.update(id(), { status: 'active' }))
      break
    case 'reveal': {
      const key = store.revealKey(id())
      if (!key) fail('Key này được tạo trước khi có tính năng sao chép, hãy dùng "rotate" để cấp key mới.')
      console.log(key)
      break
    }
    case 'rotate':
      printNewKey(store.rotate(id()))
      break
    case 'delete':
      store.remove(id()) // also deletes its usage counters
      console.log(`Đã xoá key #${args[0]}`)
      break
    case 'backup': {
      // VACUUM INTO gives a consistent snapshot even while the gateway is serving requests.
      const file = arg(0, '<file>')
      rmSync(file, { force: true })
      db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
      console.log(`Đã sao lưu database vào ${file}`)
      break
    }
    default:
      fail(`Lệnh không hợp lệ: ${command}`)
  }
} catch (err) {
  if (err instanceof StoreError) fail(err.message)
  throw err
}
