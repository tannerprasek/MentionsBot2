import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestTv } from '../src/tvmatch.js'

const tvs = ['43" The Frame', 'Living Room TV', 'Bedroom', 'Kitchen speaker']

test('exact and partial names', () => {
  assert.equal(bestTv('43" The Frame', tvs), 0)
  assert.equal(bestTv('the frame', tvs), 0)
  assert.equal(bestTv('frame tv', tvs), 0)
  assert.equal(bestTv('living room', tvs), 1)
  assert.equal(bestTv('bedroom tv', tvs), 2)
})

test('small typos', () => {
  assert.equal(bestTv('teh frame', tvs), 0)
  assert.equal(bestTv('the fram', tvs), 0)
  assert.equal(bestTv('livng rom', tvs), 1)
  assert.equal(bestTv('bedrom', tvs), 2)
  assert.equal(bestTv('43 frame', tvs), 0)
})

test('unrelated names do not match', () => {
  assert.equal(bestTv('garage', tvs), -1)
  assert.equal(bestTv('office', tvs), -1)
})

test('real TV names: LG vs the Frame', () => {
  const real = ['43" The Frame', '[LG] webOS TV OLED77', 'TCL Roku TV']
  for (const q of ['LG', 'lg tv', 'the LG', 'L.G.', 'L G', 'LG OLED', 'oled', 'webos']) assert.equal(bestTv(q, real), 1, q)
  for (const q of ['frame', 'the frame', '43 frame']) assert.equal(bestTv(q, real), 0, q)
  for (const q of ['TCL', 'roku', 'T.C.L.']) assert.equal(bestTv(q, real), 2, q)
})
