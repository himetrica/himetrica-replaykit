// Identity bridge with the analytics tracker, strictly READ-ONLY (same approach as
// ErrorKit's browser/identity.ts).
//
// The tracker (tracker-js / tracker.js) stores the ids in:
//   visitor  cookie hm_vid (cookieDomain mode) or localStorage hm_visitor_id
//   session  cookie hm_sid (cookieDomain mode) or sessionStorage hm_session_id
// We read those keys and never write them. window.himetrica.getSessionId() is NOT
// called: in the tracker it refreshes the session timestamp.
//
// A recording or a signal is only worth something tied to the tracker's visitor and
// session, so without the tracker on the page ReplayKit stays idle.

import type { Env } from "./env";

export interface Identity {
  visitorId?: string;
  sessionId?: string;
}

export function readIdentity(env: Env): Identity {
  const visitorId = env.getCookie("hm_vid") || env.getLocal("hm_visitor_id") || undefined;
  const sessionId = env.getCookie("hm_sid") || env.getSession("hm_session_id") || undefined;
  return { visitorId, sessionId };
}
