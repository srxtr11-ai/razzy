import { useEffect, useState } from 'react'
import { DoorClosed, Loader2, WifiOff } from 'lucide-react'
import { useParty } from './api.js'
import Lobby from './screens/Lobby.jsx'
import Room from './screens/Room.jsx'
import Friends, { CallOverlay, InviteCards } from './Friends.jsx'
import { Button } from './components/ui.jsx'

export default function App() {
  const party = useParty()
  const [friendsOpen, setFriendsOpen] = useState(false)

  useEffect(() => {
    if (!party.error) return
    const t = setTimeout(() => party.setError(null), 4000)
    return () => clearTimeout(t)
  }, [party.error]) // eslint-disable-line

  // Answering a call lands you in a party; the drawer has done its job.
  useEffect(() => { if (party.room) setFriendsOpen(false) }, [party.room?.code]) // eslint-disable-line

  // Android's back button should close what's open, then back out of the app —
  // never navigate the WebView to a blank history entry.
  useEffect(() => {
    const onBack = (e) => {
      if (friendsOpen) {
        e.preventDefault?.()
        setFriendsOpen(false)
        history.pushState(null, '', location.href)
        return
      }
      if (!party.room) return
      e.preventDefault?.()
      history.pushState(null, '', location.href)
    }
    history.pushState(null, '', location.href)
    window.addEventListener('popstate', onBack)
    return () => window.removeEventListener('popstate', onBack)
  }, [party.room, friendsOpen])

  const pending = party.friends.filter((f) => f.incoming).length

  /** A call has to reach you wherever you are, so this sits above every screen. */
  const social = (
    <>
      <InviteCards party={party} />
      <CallOverlay party={party} />
      <div
        className={`fixed inset-0 z-[88] transition-transform duration-300 ${
          friendsOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        }`}
        style={{ transitionTimingFunction: 'var(--ease-spring)' }}
      >
        <div
          className="h-full glass-solid"
          style={{ paddingTop: 'var(--top)', paddingBottom: 'var(--bottom)' }}
        >
          <Friends party={party} onClose={() => setFriendsOpen(false)} />
        </div>
      </div>
    </>
  )

  if (party.declined) {
    return (
      <Centre>
        <DoorClosed size={30} className="mx-auto text-white/30" />
        <p className="text-white/60">The host didn't let you in.</p>
        <Button kind="ghost" onClick={() => location.reload()}>Back</Button>
      </Centre>
    )
  }

  if (!party.room) {
    return (
      <>
        <Lobby party={party} onFriends={() => setFriendsOpen(true)} friendCount={pending} />
        {social}
      </>
    )
  }

  if (!party.you?.approved) {
    return (
      <>
        <Centre>
          <div className="text-4xl font-bold tracking-[0.3em] text-grass">{party.room.code}</div>
          <p className="text-white/50 text-sm flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            Asking the host to let you in…
          </p>
        </Centre>
        {social}
      </>
    )
  }

  return (
    <>
      <Room party={party} onFriends={() => setFriendsOpen(true)} friendCount={pending} />
      {social}
      {party.error && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[90] glass rounded-full px-5 h-11 grid place-items-center text-sm text-red-300 pop"
          style={{ bottom: 'calc(var(--bottom) + 5rem)' }}
        >
          {party.error}
        </div>
      )}
      {!party.connected && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[90] glass rounded-full px-4 h-8 flex items-center gap-2 text-xs text-yellow-300"
          style={{ top: 'calc(var(--top) + 0.5rem)' }}
        >
          <WifiOff size={12} />
          Reconnecting…
        </div>
      )}
    </>
  )
}

function Centre({ children }) {
  return (
    <div
      className="h-full grid place-items-center px-6 text-center"
      style={{ paddingTop: 'var(--top)', paddingBottom: 'var(--bottom)' }}
    >
      <div className="glass rounded-3xl p-8 space-y-3 pop">{children}</div>
    </div>
  )
}
