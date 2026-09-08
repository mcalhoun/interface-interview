# Origin policy is enforced at the browser boundary

An action's top-level page URL does not identify every document it can reach. A
permitted wrapper can embed a forbidden iframe, and an allowed form or link can
redirect a request containing member data. Checking only the executor's action
request therefore leaves an origin allowlist bypass.

The deployment binds its compiled origin policy into `PlaywrightSurface` through
an `authorizeOrigin` predicate. The surface package has no dependency on the
policy package. `originAuthorizer(policy)` supplies the predicate from the parsed
scheme, host and port patterns.

## Considered options

Checking a resulting page after navigation detects a violation after a request
has already left the browser. Checking just the destination visible in a link
misses forms, scripts and redirects. Neither protects member data in a POST body.

Playwright routing checks the initial request of a navigation but skips later
redirect hops. The Chromium adapter therefore combines initial-request routing
with Chromium request interception that checks every hop. Service workers are
blocked, and WebSocket destinations pass the same origin gate.

## Consequences

Requests are refused before transmission. All live frame origins are checked
before observations and targeted operations, so a permitted outer page cannot
authorize a forbidden inner document. The check uses frame metadata and retains
the accessibility-only observation contract.

A denial latches a `SurfaceUnavailable` failure and stops the whole surface.
Required cross-origin frames and assets must be listed explicitly. Standalone
construction without a predicate permits only the `startUrl` origin; with neither
option it denies network access. Deployment entrypoints pass the compiled policy
rather than relying on that standalone default.

Real Chromium regression tests cover forbidden frames, links, GET and POST forms,
redirect chains and cross-site iframe redirects. Positive cases preserve allowed
frames and final redirect locations. This origin boundary does not add path-level
permissions, transaction approval or protection against arbitrary sensitive text
on an allowed page.
