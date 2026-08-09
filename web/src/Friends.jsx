import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft, Check, Copy, KeyRound, LogIn, Phone, PhoneOff, Send,
  Swords, UserPlus, UserX, Users, X,
} from 'lucide-react'
import { Avatar, Button } from './ui.jsx'

/**
 * Friends, private chat, invites and calls.
 *
 * Written once and used by both clients — the website slides it in from the
 * right, the app shows it full screen — so the two can't drift apart the way
 * the players did. `ui` supplies the handful of class names that differ.
 */

const ago = (t) => {
  if (!t) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** The running score at Stack. Nothing shown until there's something to show. */
export function Record({ record, name, full }) {
  if (!record) return null
  const { mine = 0, theirs = 0, draws = 0 } = record
  if (!mine && !theirs && !draws) return null
  const lead = mine === theirs ? 'level' : mine > theirs ? 'you' : 'them'
  const tint = lead === 'you' ? 'text-grass' : lead === 'them' ? 'text-white/70' : 'text-white/50'
  return (
    <span className={`inline-flex items-center gap-1.5 ${tint}`}>
      <Swords size={11} className="shrink-0" />
      <span className="font-semibold tabular-nums">{mine}–{theirs}</span>
      {full && (
        <span className="text-white/40 font-normal">
          {lead === 'level' ? 'all square' : lead === 'you' ? "you're ahead" : `${name} is ahead`}
          {draws > 0 ? `, ${draws} drawn` : ''}
        </span>
      )}
    </span>
  )
}

/** A friend's row: who they are, whether they're about, and what they're watching. */
function Row({ f, onOpen, onAccept, onJoin }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl p-2 hover:bg-white/6">
      <button onClick={onOpen} className="press relative shrink-0">
        <Avatar m={f} size={40} dim={!f.online} />
        <span
          className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full"
          style={{ background: f.online ? 'var(--color-grass)' : '#4b5563', boxShadow: '0 0 0 2.5px #0d0f13' }}
        />
      </button>

      <button onClick={onOpen} className="press flex-1 min-w-0 text-left">
        <div className="text-sm font-semibold truncate">{f.name}</div>
        <div className="text-[11px] text-white/40 truncate flex items-center gap-2">
          {f.incoming ? 'Wants to be friends' : f.outgoing ? 'Request sent' : null}
          {f.accepted && (
            <>
              <span className="truncate">
                {f.party ? `In party ${f.party}` : f.online ? 'Online' : `Last seen ${ago(f.seen)}`}
              </span>
              <Record record={f.record} name={f.name} />
            </>
          )}
        </div>
      </button>

      {f.incoming ? (
        <Button kind="primary" className="px-3 h-9 shrink-0" onClick={onAccept}>
          <Check size={15} strokeWidth={3} />
          Accept
        </Button>
      ) : f.party ? (
        <Button kind="ghost" className="px-3 h-9 shrink-0 bg-grass/15 text-grass" onClick={onJoin}>
          <LogIn size={14} />
          Join
        </Button>
      ) : null}
    </div>
  )
}

/** The private chat with one friend, plus everything you can do to them. */
function Thread({ party, f, onBack, onClose }) {
  const [text, setText] = useState('')
  const list = useRef(null)
  const msgs = party.threads[f.id] || []

  useEffect(() => { party.openThread(f.id) }, [f.id]) // eslint-disable-line
  useEffect(() => { list.current?.scrollTo({ top: 1e9, behavior: 'smooth' }) }, [msgs.length])

  const inParty = !!party.room
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-2 shrink-0">
        <button onClick={onBack} className="press grid place-items-center w-11 h-11 rounded-xl bg-white/6 shrink-0">
          <ArrowLeft size={18} />
        </button>
        <Avatar m={f} size={34} dim={!f.online} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{f.name}</div>
          <div className="text-[11px] text-white/40 truncate flex items-center gap-2">
            <span className="truncate">
              {f.party ? `In party ${f.party}` : f.online ? 'Online' : `Last seen ${ago(f.seen)}`}
            </span>
            <Record record={f.record} name={f.name} />
          </div>
        </div>
        <button
          onClick={() => party.removeFriend(f.id)}
          className="press grid place-items-center w-11 h-11 rounded-xl text-white/35 hover:text-red-300 hover:bg-red-500/15 shrink-0"
          title="Remove friend"
        >
          <UserX size={17} />
        </button>
        {/* Out of the whole panel, not just back to the list — being one screen
            deep shouldn't mean two taps to leave. */}
        {onClose && (
          <button
            onClick={onClose}
            className="press grid place-items-center w-11 h-11 rounded-xl bg-white/6 shrink-0"
            aria-label="Close friends"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* The three things worth doing from here. Calling needs a party to drop
          them into, so it says so rather than failing silently. */}
      <div className="flex gap-2 px-2 pb-2 shrink-0">
        {f.party && (
          <Button kind="ghost" className="flex-1 h-10 bg-grass/15 text-grass" onClick={() => party.joinCode(f.party)}>
            <LogIn size={15} />
            Join {f.party}
          </Button>
        )}
        <Button
          kind="ghost" className="flex-1 h-10" disabled={!inParty || !f.online}
          title={inParty ? '' : 'Start a party first'}
          onClick={() => party.invite(f.id)}
        >
          <UserPlus size={15} />
          Invite
        </Button>
        <Button
          kind="ghost" className="flex-1 h-10" disabled={!inParty || !f.online}
          title={inParty ? '' : 'Start a party first'}
          onClick={() => party.call(f.id)}
        >
          <Phone size={15} />
          Call
        </Button>
      </div>

      {/* Needs no party — it's something to do instead of watching. */}
      <div className="px-2 pb-2 shrink-0">
        <Button
          kind="ghost" className="w-full h-10 bg-white/6" disabled={!f.online}
          title={f.online ? 'One round each, highest tower wins' : 'They are offline'}
          onClick={() => party.challengeFriend(f.id)}
        >
          <Swords size={15} />
          Challenge at Stack
        </Button>
      </div>

      <div ref={list} className="flex-1 overflow-y-auto no-scrollbar px-3 space-y-2 min-h-0">
        {!msgs.length && (
          <p className="text-center text-[11px] text-white/25 py-6">
            Nothing yet. Say hello, or call them into a party.
          </p>
        )}
        {msgs.map((m) => {
          const mine = m.from === party.me?.id
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[78%] rounded-2xl px-3 py-1.5 text-sm break-words ${mine ? 'bg-grass/25' : 'bg-white/8'}`}
                style={{ boxShadow: 'inset 0 1px 1px rgba(255,255,255,.12)' }}
              >
                {m.text}
              </div>
            </div>
          )
        })}
      </div>

      <form
        className="p-2 flex gap-2 shrink-0"
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim()) return
          party.sendDm(f.id, text.trim())
          setText('')
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Message ${f.name}…`}
          className="flex-1 min-w-0 bg-white/8 rounded-full px-4 h-11 text-sm outline-none focus:bg-white/12"
        />
        <Button kind="primary" type="submit" className="px-4 shrink-0" aria-label="Send">
          <Send size={16} />
        </Button>
      </form>
    </div>
  )
}

export default function Friends({ party, onClose }) {
  const [openId, setOpenId] = useState(null)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [rCode, setRCode] = useState('')
  const [rKey, setRKey] = useState('')

  const open = party.friends.find((f) => f.id === openId)
  const requests = party.friends.filter((f) => f.incoming)
  const rest = party.friends.filter((f) => !f.incoming)

  if (open) return <Thread party={party} f={open} onBack={() => setOpenId(null)} onClose={onClose} />

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 shrink-0">
        <Users size={16} className="text-grass" />
        <span className="text-[11px] uppercase tracking-[0.2em] text-white/35 flex-1">Friends</span>
        {onClose && (
          <button
            onClick={onClose}
            className="press grid place-items-center w-11 h-11 rounded-xl bg-white/6 shrink-0"
            aria-label="Close friends"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Your own code, which is the only thing anyone needs to add you. */}
      <div className="px-3 pb-2 shrink-0">
        <button
          onClick={() => {
            navigator.clipboard?.writeText(party.me?.code || '').then(() => {
              setCopied(true); setTimeout(() => setCopied(false), 1500)
            }).catch(() => {})
          }}
          className="press w-full flex items-center gap-3 rounded-2xl px-4 h-14 bg-white/6 hover:bg-white/10"
        >
          <div className="flex-1 text-left min-w-0">
            <div className="text-[10px] uppercase tracking-[0.2em] text-white/35">Your code</div>
            <div className="font-bold tracking-[0.25em] text-grass">{party.me?.code || '······'}</div>
          </div>
          {copied ? <Check size={16} className="text-grass" /> : <Copy size={15} className="text-white/40" />}
        </button>
      </div>

      <form
        className="px-3 pb-3 flex gap-2 shrink-0"
        onSubmit={(e) => {
          e.preventDefault()
          if (code.length === 6) { party.addFriend(code); setCode('') }
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6))}
          placeholder="THEIR CODE"
          autoCapitalize="characters"
          autoCorrect="off"
          className="flex-1 min-w-0 bg-white/8 rounded-full px-4 h-11 text-sm tracking-[0.2em] outline-none focus:bg-white/12"
        />
        <Button kind="primary" type="submit" className="px-4 shrink-0" disabled={code.length !== 6}>
          <UserPlus size={16} />
        </Button>
      </form>

      <div className="flex-1 overflow-y-auto no-scrollbar px-2 pb-2 min-h-0">
        {requests.length > 0 && (
          <div className="px-2 pt-1 pb-1 text-[11px] uppercase tracking-[0.2em] text-grass/70">
            Wants to be friends
          </div>
        )}
        {requests.map((f) => (
          <Row key={f.id} f={f} onOpen={() => party.acceptFriend(f.id)} onAccept={() => party.acceptFriend(f.id)} />
        ))}

        {!party.friends.length && (
          <p className="text-center text-xs text-white/25 py-10 px-6 leading-relaxed">
            Nobody yet. Share your code, or type someone else's above.
          </p>
        )}

        {rest.map((f) => (
          <Row
            key={f.id}
            f={f}
            onOpen={() => f.accepted && setOpenId(f.id)}
            onJoin={() => party.joinCode(f.party)}
          />
        ))}
      </div>

      {/* Moving to a new phone, or clearing the browser, would otherwise lose
          every friend — this is the only way back to the same identity. */}
      <div className="px-3 pb-3 shrink-0">
        <button
          onClick={() => setShowKey((v) => !v)}
          className="press w-full flex items-center justify-center gap-2 text-[11px] text-white/30 py-2"
        >
          <KeyRound size={12} />
          Move to another device
        </button>
        {showKey && (
          <div className="space-y-2 rise">
            <p className="text-[11px] text-white/35 leading-snug px-1">
              Write these down. Entering them on another device makes it you — same
              code, same friends, same chats.
            </p>
            <div className="flex gap-2 text-center">
              <div className="flex-1 rounded-xl bg-white/6 py-2">
                <div className="text-[10px] text-white/35">CODE</div>
                <div className="font-bold tracking-[0.2em] text-grass text-sm">{party.me?.code}</div>
              </div>
              <div className="flex-1 rounded-xl bg-white/6 py-2">
                <div className="text-[10px] text-white/35">KEY</div>
                <div className="font-bold tracking-[0.15em] text-sm">{party.me?.key}</div>
              </div>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => { e.preventDefault(); party.restore(rCode.trim(), rKey.trim()) }}
            >
              <input
                value={rCode} onChange={(e) => setRCode(e.target.value.toUpperCase())}
                placeholder="CODE" className="w-24 min-w-0 bg-white/6 rounded-xl px-3 h-10 text-xs outline-none" />
              <input
                value={rKey} onChange={(e) => setRKey(e.target.value.toUpperCase())}
                placeholder="KEY" className="flex-1 min-w-0 bg-white/6 rounded-xl px-3 h-10 text-xs outline-none" />
              <Button kind="ghost" type="submit" className="px-3 h-10 text-xs">Restore</Button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}

/** Full-screen ringing. No audio anywhere — answering just walks you in. */
export function CallOverlay({ party }) {
  const { ring, calling } = party
  const call = ring || calling
  if (!call) return null
  const person = ring ? ring.from : party.friends.find((f) => f.id === calling.to)

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/[.88] px-6">
      <div className="liquid rounded-[2rem] p-8 w-full max-w-sm text-center space-y-5 card-in">
        <div className="relative mx-auto w-fit">
          <Avatar m={person} size={88} />
          {ring && <span className="absolute inset-0 rounded-full ring-4 ring-grass/50 animate-ping" />}
        </div>
        <div>
          <div className="text-xl font-semibold">{person?.name || 'Someone'}</div>
          <div className="text-sm text-white/50">
            {ring ? `Wants you in party ${ring.code}` : 'Ringing…'}
          </div>
        </div>

        {ring ? (
          <div className="flex gap-3">
            <Button kind="danger" className="flex-1 h-12" onClick={() => party.declineCall(ring.callId)}>
              <PhoneOff size={18} />
              Decline
            </Button>
            <Button kind="primary" className="flex-1 h-12" onClick={() => party.answerCall(ring.callId)}>
              <Phone size={18} />
              Answer
            </Button>
          </div>
        ) : (
          <Button kind="danger" className="w-full h-12" onClick={() => party.cancelCall(calling.callId)}>
            <PhoneOff size={18} />
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

/** "Come watch this" — quieter than a call, and it waits. */
export function InviteCards({ party }) {
  if (!party.invites.length) return null
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] w-[min(92vw,24rem)] space-y-2">
      {party.invites.map((v) => (
        <div key={v.from.id} className="liquid rounded-3xl p-3 flex items-center gap-3 card-in">
          <Avatar m={v.from} size={40} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold truncate">{v.from.name}</div>
            <div className="text-[11px] text-white/45">Invited you to party {v.code}</div>
          </div>
          <Button
            kind="primary" className="px-4 h-10 shrink-0"
            onClick={() => { party.dismissInvite(v.from.id); party.joinCode(v.code) }}
          >
            Join
          </Button>
          <button
            onClick={() => party.dismissInvite(v.from.id)}
            className="press grid place-items-center w-8 h-8 rounded-full text-white/35 shrink-0"
            aria-label="Dismiss"
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}
