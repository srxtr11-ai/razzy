/**
 * The players are the web client's, verbatim.
 *
 * This file used to be a 170-line copy of it, which is precisely why a
 * buffering fix could land on the website and leave the app still broken. There
 * is nothing phone-specific in here — `lib.js` is already shared across the
 * root the same way — so it is one import instead.
 */
export * from '../../../web/src/players.jsx'
