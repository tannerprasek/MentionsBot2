// Answers mDNS lookups for "castbot.local" with this PC's home-network address, so the Siri
// Shortcuts can use http://castbot.local:8787 and keep working when the PC's IP changes.
import mdns from 'multicast-dns'
import { config } from './config.js'

export const HOSTNAME = 'castbot.local'

const responder = mdns()
responder.on('error', (err) => console.error('[mdns]', err.message))
responder.on('query', (q) => {
  if (!q.questions.some((x) => x.name.toLowerCase() === HOSTNAME && (x.type === 'A' || x.type === 'ANY'))) return
  responder.respond({ answers: [{ name: HOSTNAME, type: 'A', ttl: 120, data: config.publicHost }] })
})
