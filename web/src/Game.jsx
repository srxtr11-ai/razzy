import { useEffect, useRef, useState } from 'react'
import { Gamepad2, Swords, Trophy, X } from 'lucide-react'
import { Avatar, Button } from './ui.jsx'
import { Record } from './Friends.jsx'

/**
 * Stack, either on your own while the host is away or head-to-head against a
 * friend from a private chat.
 *
 * The game itself is a plain page in an iframe — it binds taps and the spacebar
 * to `window` and appends a canvas to `document.body`, so inlined here it would
 * swallow every tap in the app. That means the score has to be handed out rather
 * than read: the game posts it, this listens.
 */
export default function GameOverlay({ party, solo, onClose }) {
  const frame = useRef(null)
  const [mine, setMine] = useState(null)
  const match = solo ? null : party.match

  const me = party.me?.id
  const scores = match?.scores || {}
  const theirs = match?.opponent ? scores[match.opponent.id] : null
  const both = match?.done
  // The friend row carries the running score, kept up to date by the server.
  const friend = party.friends.find((f) => f.id === match?.opponent?.id)

  // Tell the game it's a match, so it leaves the ending to us.
  const arm = () => {
    frame.current?.contentWindow?.postMessage({ razzy: 'command', cmd: 'match', on: !!match }, '*')
  }

  useEffect(() => {
    const onMessage = (e) => {
      if (e.source !== frame.current?.contentWindow) return
      const d = e.data
      if (d?.razzy === 'ready') return arm()
      if (d?.razzy !== 'score') return
      setMine(d.score)
      if (match && scores[me] == null) party.reportScore(match.matchId, d.score)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }) // no dep array: it needs the current match every render, and it's one listener

  const rematch = () => {
    setMine(null)
    party.challengeFriend(match.opponent.id)
    frame.current?.contentWindow?.postMessage({ razzy: 'command', cmd: 'restart' }, '*')
  }

  const quit = () => (match ? party.quitMatch(match.matchId) : onClose?.())

  return (
    <div className="fixed inset-0 z-[92] bg-ink">
      <iframe ref={frame} src="/game/" title="Stack" className="w-full h-full border-0" onLoad={arm} />

      <button
        onClick={quit}
        className="liquid press absolute right-4 z-10 rounded-2xl pl-3 pr-4 h-11 flex items-center gap-2 text-xs font-semibold"
        style={{ top: 'max(1rem, env(safe-area-inset-top))' }}
      >
        <X size={15} />
        {match ? 'Give up' : 'Back to the party'}
      </button>

      {/* Who you're against, and where you both are. */}
      {match?.opponent && !both && (
        <div
          className="liquid absolute left-4 z-10 rounded-2xl px-4 h-11 flex items-center gap-3 text-xs"
          style={{ top: 'max(1rem, env(safe-area-inset-top))' }}
        >
          <Swords size={14} className="text-grass" />
          <span className="font-semibold">vs {match.opponent.name}</span>
          <span className="text-white/40">
            {mine == null
              ? 'your turn'
              : theirs == null
                ? `you: ${mine} — waiting for them`
                : `${mine} – ${theirs}`}
          </span>
        </div>
      )}

      {/* The result. Only this page can say it — the game has no idea there's
          anyone else playing. */}
      {both && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-black/[.88] px-6">
          <div className="liquid rounded-[2rem] p-8 w-full max-w-sm text-center space-y-5 card-in">
            <Trophy
              size={40}
              className={`mx-auto ${match.winner === me ? 'text-yellow-400' : 'text-white/30'}`}
            />
            <div>
              <h2 className="text-xl font-semibold">
                {match.winner == null ? 'A draw' : match.winner === me ? 'You won' : `${match.opponent.name} won`}
              </h2>
              <p className="text-sm text-white/50 mt-1">
                {match.winner == null ? 'Same tower, both of you.' : 'Highest tower takes it.'}
              </p>
            </div>

            <div className="flex items-center justify-center gap-6">
              <Score name="You" value={scores[me]} win={match.winner === me} />
              <span className="text-white/20 text-lg">–</span>
              <Score
                name={match.opponent.name}
                value={scores[match.opponent.id]}
                win={match.winner === match.opponent.id}
                m={match.opponent}
              />
            </div>

            {/* The running score, which is the reason to play again. */}
            <div className="text-xs">
              <Record record={friend?.record} name={match.opponent.name} full />
            </div>

            <div className="flex gap-3">
              <Button kind="ghost" className="flex-1" onClick={quit}>Done</Button>
              <Button kind="primary" className="flex-1" onClick={rematch}>Rematch</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Score({ name, value, win, m }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      {m ? <Avatar m={m} size={38} /> : <div className="w-[38px] h-[38px] rounded-full bg-grass/20 grid place-items-center"><Gamepad2 size={17} className="text-grass" /></div>}
      <div className={`text-3xl font-bold tabular-nums ${win ? 'text-grass' : 'text-white/60'}`}>{value ?? '–'}</div>
      <div className="text-[11px] text-white/40 max-w-20 truncate">{name}</div>
    </div>
  )
}

/** "X wants to play" — the same shape as an invite, because it is one. */
export function ChallengeCard({ party }) {
  const c = party.challenge
  if (!c) return null
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[86] w-[min(92vw,24rem)]">
      <div className="liquid rounded-3xl p-3 flex items-center gap-3 card-in">
        <Avatar m={c.from} size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate">{c.from.name}</div>
          <div className="text-[11px] text-white/45">Challenges you at Stack</div>
        </div>
        <Button kind="primary" className="px-4 h-10 shrink-0" onClick={() => party.acceptChallenge(c.matchId)}>
          Play
        </Button>
        <button
          onClick={() => party.declineChallenge(c.matchId)}
          className="press grid place-items-center w-9 h-9 rounded-full text-white/35 shrink-0"
          aria-label="Decline"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  )
}

/** Shown to whoever threw down, until the other side picks it up. */
export function WaitingForChallenge({ party }) {
  const m = party.match
  if (!m?.waitingForThem) return null
  const who = party.friends.find((f) => f.id === m.opponentId)
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[86] liquid rounded-full pl-5 pr-2 h-12 flex items-center gap-3 text-sm card-in">
      <Swords size={15} className="text-grass" />
      <span>Waiting for {who?.name || 'them'}…</span>
      <button
        onClick={() => party.quitMatch(m.matchId)}
        className="press rounded-full px-3 h-8 bg-white/8 text-xs"
      >
        Cancel
      </button>
    </div>
  )
}
