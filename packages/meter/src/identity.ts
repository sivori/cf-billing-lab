/**
 * Who is acting.
 *
 * PROJECT 1 has no authentication, so it claims none: every actor is `public-demo`. The header
 * Cloudflare Access sets is deliberately NOT read here — on a public deployment any caller can
 * send `cf-access-authenticated-user-email: ceo@example.com`, and an audit trail that records a
 * spoofable string is worse than one that records nothing, because it looks like evidence.
 *
 * PROJECT 3 ("gate") replaces the body of this function with real Access JWT validation —
 * verifying the signature against the team's JWKS inside the Worker rather than trusting the edge
 * — and only then does the identity become worth writing down. The module exists now so that
 * change is a swap, not a refactor of every admin route.
 */
export function actorFor(_request: Request): string {
  return "public-demo";
}
