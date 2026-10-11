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
