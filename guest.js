// Dev helper: a scripted guest that joins a party and chats, so multi-user
// behaviour can be exercised without a second browser profile.
// Usage: node guest.js <CODE> [name] [port]
import { WebSocket } from 'ws'

const [code, name = 'Sara', port = 8080] = process.argv.slice(2)
if (!code) { console.error('usage: node guest.js <CODE> [name] [port]'); process.exit(1) }

const ws = new WebSocket(`ws://localhost:${port}/ws`)
let approved = false

ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code: code.toUpperCase(), name })))

ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', ts: m.ts }))
  if (m.type === 'joined') return console.log(`joined ${m.room.code} as ${name}`)
  if (m.type === 'error') return console.log('error:', m.error)
  if (m.type === 'declined') { console.log('declined'); process.exit(0) }
  if (m.type === 'state') {
    const me = m.room.members.find((x) => x.name === name)
    if (me?.approved && !approved) {
      approved = true
      console.log('approved — chatting')
      let n = 0
      setInterval(() => ws.send(JSON.stringify({ type: 'chat', text: `message ${++n} from ${name}` })), 6000)
    }
    // stay in sync so the room does not stall waiting for us
    ws.send(JSON.stringify({ type: 'tick', t: m.room.t, buffering: false, paused: m.room.paused }))
  }
})

ws.on('close', () => process.exit(0))
