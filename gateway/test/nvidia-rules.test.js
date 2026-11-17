import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeRuleFilter } from '../src/nvidia-stream.js'

const run = (pieces) => {
  const f = makeRuleFilter()
  return pieces.map((p) => f.push(p)).join('') + f.flush()
}

test('drops a line that is only ---', () => {
  assert.equal(run(['Phần 1\n\n---\n\nPhần 2']), 'Phần 1\n\n\nPhần 2')
})

test('drops it when the dashes arrive in separate pieces', () => {
  assert.equal(run(['A\n-', '-', '-\nB']), 'A\nB')
})

test('drops a rule at the very end of the text', () => {
  assert.equal(run(['A\n\n---']), 'A\n\n')
})

test('keeps dashes inside text, lists, tables and negative numbers', () => {
  const text = '- một\n- hai\n| a | b |\n|---|---|\nx --- y\n-5 độ\n--flag'
  assert.equal(run([text]), text)
})

test('keeps --- inside a code block', () => {
  const text = 'ví dụ:\n```yaml\n---\nname: x\n---\n```\nxong'
  assert.equal(run([text]), text)
})

test('piece-by-piece equals all at once', () => {
  const text = 'a\n---\nb\n```\n---\n```\n- c\n---\n'
  assert.equal(run([...text]), run([text]))
})
