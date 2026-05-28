# Security fix: Path Traversal in `GET /api/brain/note` (multi-vault read)

## Summary
The multi-vault note read path (`?path=<vaultName>::<relPath>`) passes the
client-controlled `rel` directly to `path.join(v.path, rel)` + `fs.readFile`
with no containment check. A request like `?path=myvault::../../../../etc/passwd`
escapes the vault directory and reads arbitrary files readable by the server
process. Severity: **HIGH** (arbitrary file read).

## Fix (defense-in-depth)
1. **Fast precheck** `isUnsafeRelPath()` — rejects absolute paths, Windows drive
   prefixes, and any `..` segment.
2. **Realpath containment** — `realpath` both the vault root and the resolved
   candidate, then assert the candidate is the vault root or lives under it
   (`vaultReal + path.sep`). Symlink-safe.
3. **Extension allowlist** — only `.md` notes are served.

No behavioural change for legitimate relative note paths (e.g. `notes/x.md`).

## Test
Precheck verified against payloads: `../../../etc/passwd`, `/etc/passwd`,
`a/../../b`, `C:\win` → rejected; `notes/x.md`, `ok/sub/file.md` → allowed.
Backend `tsc --noEmit` clean.

Found via automated security review during a downstream integration.
