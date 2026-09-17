/**
 * Who is acting.
 *
 * PROJECT 3 ("gate") replaces the body of this function with Access JWT validation — verifying the
 * signature against the team's JWKS inside the Worker rather than trusting the edge. It lives in
 * its own module from day one so that change is a swap, not a refactor of every admin route, and
 * so the audit trail has a real column to fill the moment identity exists.
 */
export function actorFor(request: Request): string {
  const assertion = request.headers.get("cf-access-authenticated-user-email");
  return assertion ?? "public-demo";
}
