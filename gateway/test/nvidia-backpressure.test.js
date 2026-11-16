import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { relayOpenAiStreamToAnthropic } from '../src/nvidia-stream.js'

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const delta = (content, finish = null) => sse({ choices: [{ delta: content ? { content } : {}, finish_reason: finish }] })

test('a slow reader slows the relay down: nothing more is pulled from NVIDIA until the client has drained', async () => {
  // A client that cannot keep up: write() says "full" and drains 20 ms later.
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableNeedDrain: false,
    out: [],
    ended: false,
    write(s) {
      this.out.push(s)
      this.writableNeedDrain = true
      setTimeout(() => {
        this.writableNeedDrain = false
        this.emit('drain')
      }, 20)
      return false
    },
    end() {
      this.ended = true
    },
  })
  const pulledWhileFull = []
  async function* upstream() {
    for (const piece of [delta('a'), delta('b'), delta('c'), delta('', 'stop'), 'data: [DONE]\n\n']) {
      pulledWhileFull.push(res.writableNeedDrain)
      yield piece
    }
  }
  await relayOpenAiStreamToAnthropic(upstream(), res, { requestedModel: 'm' })
  assert.ok(res.ended)
  assert.ok(res.out.join('').includes('message_stop'), 'the answer still arrives complete')
  // the first pull happens before any write; every later one must find the client drained
  assert.deepEqual(pulledWhileFull.slice(1), [false, false, false, false])
})

test('a client that disconnects while the relay waits does not hang it', async () => {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableNeedDrain: true, // full, and it will never drain
    out: [],
    write(s) {
      this.out.push(s)
      return false
    },
    end() {},
  })
  setTimeout(() => {
    res.destroyed = true
    res.emit('close')
  }, 30)
  async function* upstream() {
    yield delta('a')
    yield delta('b')
  }
  await Promise.race([
    relayOpenAiStreamToAnthropic(upstream(), res, { requestedModel: 'm' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('relay hung')), 2000)),
  ])
})
