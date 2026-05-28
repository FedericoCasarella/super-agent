# Security fix: IDOR in `POST /api/tools/:name` (service-header impersonation)

## Summary
`/tools/:name` is mounted before `requireUser` so the local MCP bridge (which
has no cookie) can invoke tools via the `x-super-agent-user` header. The header
value is trusted unconditionally as the acting `userId`:

```ts
let userId = Number.isFinite(headerUid) && headerUid > 0 ? headerUid : NaN;
```

Any caller that can reach the port can set `x-super-agent-user: <any id>` and
invoke that user's connector tools (read mail, query CRM, etc.). Severity:
**HIGH** (IDOR / cross-user impersonation, leading to data access as the victim).

## Fix (architecture-preserving)
Trust the service header **only from loopback** (`127.0.0.1` / `::1`). The MCP
bridge always connects over loopback, so its behaviour is unchanged; remote
callers fall through to cookie auth. This is the minimal change that closes the
hole without altering the bridge's no-cookie design.

```ts
let userId = (isLoopbackReq(req) && Number.isFinite(headerUid) && headerUid > 0) ? headerUid : NaN;
```

## Note
`GET /api/tools` (tool-list metadata) remains pre-auth — it exposes only tool
names/descriptions/schemas, no user data. Gating it to loopback too is a
reasonable follow-up if you want to avoid leaking the connector inventory.

If you deploy behind a reverse proxy, ensure `app.set('trust proxy', ...)` is
configured so `req.ip` reflects the real client (otherwise loopback detection
should use `req.socket.remoteAddress`, already included as a fallback).

Found via automated security review during a downstream integration.
