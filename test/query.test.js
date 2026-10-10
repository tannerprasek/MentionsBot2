import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRequest } from '../src/query.js'

test('movie', () => {
  assert.deepEqual(parseRequest('Play Dune Part Two').query, 'Dune Part Two')
})
test('spoken season/episode', () => {
  const r = parseRequest('breaking bad season two episode 3')
  assert.equal(r.query, 'breaking bad S02E03')
  assert.equal(r.isSeries, true)
})
test('SxxEyy', () => {
  assert.equal(parseRequest('The Office s4e12').query, 'The Office S04E12')
})
test('season only', () => {
  assert.equal(parseRequest('Severance season 1').query, 'Severance S01')
})
