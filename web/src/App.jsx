import { useEffect, useState } from 'react'
import { DoorClosed, Loader2, WifiOff } from 'lucide-react'
import { useParty } from './party.js'
import Lobby, { Ambient } from './Lobby.jsx'
import Room from './Room.jsx'
import Friends, { CallOverlay, InviteCards } from './Friends.jsx'
import { Button } from './ui.jsx'

export default function App() {
  const party = useParty()
  const [friendsOpen, setFriendsOpen] = useState(false)

  useEffect(() => {
    if (!party.error) return
    const t = setTimeout(() => party.setError(null), 4000)
    return () => clearTimeout(t)
  }, [party.error]) // eslint-disable-line react-hooks/exhaustive-deps

  // Answering a call joins a party, so the drawer has done its job — get out of
  // the way of the film.
  useEffect(() => { if (party.room) setFriendsOpen(false) }, [party.room?.code]) // eslint-disable-line

  /** Rings, invite cards and the friends drawer sit above everything, in the
      lobby and in a room alike — a call has to reach you wherever you are. */
  const social = (
    <>
      <InviteCards party={party} />
      <CallOverlay party={party} />
      <div
        className={`fixed inset-y-0 right-0 z-[85] w-[min(92vw,24rem)] transition-transform duration-400 ease-[cubic-bezier(.34,1.2,.64,1)]
          ${friendsOpen ? 'translate-x-0' : 'translate-x-full pointer-events-none'}`}
      >
        <div className="h-full m-2 rounded-[1.75rem] liquid overflow-hidden">
          <Friends party={party} onClose={() => setFriendsOpen(false)} />
        </div>
      </div>
      {friendsOpen && <div className="fixed inset-0 z-[84]" onClick={() => setFriendsOpen(false)} />}
    </>
  )

  const pending = party.friends.filter((f) => f.incoming).length

  if (party.declined) {
    return (
      <>
        <Ambient />
        <div className="h-full grid place-items-center p-6 text-center">
          <div className="liquid rounded-[2rem] p-8 space-y-4 card-in">
            <DoorClosed size={30} className="mx-auto text-white/30" />
            <p className="text-white/60">The host didn't let you in.</p>
            <Button kind="ghost" onClick={() => location.reload()}>Back</Button>
          </div>
        </div>
      </>
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

  // Approved members watch; everyone else waits at the door.
  if (!party.you?.approved) {
    return (
      <>
        <Ambient />
        <div className="h-full grid place-items-center p-6 text-center">
          <div className="liquid rounded-[2rem] px-10 py-8 space-y-2 card-in">
            <div className="text-4xl font-bold tracking-[0.3em] text-grass">{party.room.code}</div>
            <p className="text-white/50 text-sm flex items-center justify-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              Asking the host to let you in…
            </p>
          </div>
        </div>
        {social}
      </>
    )
  }

  return (
    <>
      <Room party={party} onFriends={() => setFriendsOpen(true)} friendCount={pending} />
      {social}
      {party.error && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] liquid rounded-full px-5 h-11 grid place-items-center text-sm text-red-300 card-in">
          {party.error}
        </div>
      )}
      {!party.connected && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] liquid rounded-full px-4 h-8 flex items-center gap-2 text-xs text-yellow-300 card-in">
          <WifiOff size={13} />
          Reconnecting…
        </div>
      )}
    </>
  )
}
