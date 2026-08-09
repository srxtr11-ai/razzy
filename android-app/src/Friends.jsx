/**
 * The website's friends panel, verbatim — list, private chat, invites and the
 * ringing call overlay. Nothing in it is platform-specific, and keeping one copy
 * is the whole point: the players were duplicated once and the app spent a
 * release with a bug the website no longer had.
 *
 * `theme.css` defines the couple of class names it expects (`liquid`, `card-in`)
 * in the app's own terms.
 */
export { default, CallOverlay, InviteCards } from '../../web/src/Friends.jsx'
