#!/usr/bin/env bash
# Polpo Brain · super-agent smoke test
#
# Validates that a fresh deploy is reachable and the security posture is
# correctly applied. Designed to be safe to run repeatedly: it boots the
# backend on an ephemeral port, exercises the public surface, and tears
# everything down on exit (including on Ctrl-C).
#
# Usage:
#   ./scripts/smoke.sh                  # uses DATABASE_URL from env or .env
#   PORT=9999 ./scripts/smoke.sh        # override port
#   SKIP_BUILD=1 ./scripts/smoke.sh     # skip tsc build (faster reruns)
#
# Exit code 0 = all checks passed. Non-zero with description on failure.

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
PORT="${PORT:-8788}"
HOST="${HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"
TIMEOUT_BOOT=30
BACKEND_LOG="$(mktemp -t super_agent_smoke.XXXXXX.log)"
BACKEND_PID=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─── Pretty printing ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_OK="$(printf '\033[32m')"; C_FAIL="$(printf '\033[31m')"
  C_WARN="$(printf '\033[33m')"; C_DIM="$(printf '\033[2m')"; C_RST="$(printf '\033[0m')"
else
  C_OK=""; C_FAIL=""; C_WARN=""; C_DIM=""; C_RST=""
fi

step() { printf '%s▸%s %s\n' "${C_DIM}" "${C_RST}" "$*"; }
ok()   { printf '%s✓%s %s\n' "${C_OK}" "${C_RST}" "$*"; }
warn() { printf '%s⚠%s %s\n' "${C_WARN}" "${C_RST}" "$*"; }
fail() { printf '%s✗%s %s\n' "${C_FAIL}" "${C_RST}" "$*" >&2; }

# ─── Cleanup ─────────────────────────────────────────────────────────────────
cleanup() {
  local rc=$?
  if [[ -n "${BACKEND_PID}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    step "stopping backend pid ${BACKEND_PID}"
    kill "${BACKEND_PID}" 2>/dev/null || true
    # Give it a moment; SIGKILL if it lingers
    for _ in 1 2 3 4 5; do
      kill -0 "${BACKEND_PID}" 2>/dev/null || break
      sleep 0.3
    done
    kill -9 "${BACKEND_PID}" 2>/dev/null || true
  fi
  if [[ ${rc} -ne 0 && -s "${BACKEND_LOG}" ]]; then
    echo
    warn "backend log tail (full at ${BACKEND_LOG}):"
    tail -n 30 "${BACKEND_LOG}" | sed 's/^/    /'
  else
    rm -f "${BACKEND_LOG}" 2>/dev/null || true
  fi
  exit ${rc}
}
trap cleanup EXIT INT TERM

# ─── Preflight ───────────────────────────────────────────────────────────────
step "preflight"

if [[ ! -f "${REPO_DIR}/backend/package.json" ]]; then
  fail "not in super-agent repo (expected ${REPO_DIR}/backend/package.json)"
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  fail "node not in PATH"
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  fail "curl not in PATH"
  exit 2
fi

# JWT_SECRET is fail-fast in config.ts now. Either supply one or refuse.
if [[ -z "${JWT_SECRET:-}" ]]; then
  if [[ -f "${REPO_DIR}/.env" ]] && grep -q '^JWT_SECRET=' "${REPO_DIR}/.env"; then
    ok "JWT_SECRET present in .env"
  else
    warn "JWT_SECRET missing — generating ephemeral one for this smoke run"
    export JWT_SECRET
    JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))')"
  fi
else
  ok "JWT_SECRET present in env (${#JWT_SECRET} chars)"
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  if [[ -f "${REPO_DIR}/.env" ]] && grep -q '^DATABASE_URL=' "${REPO_DIR}/.env"; then
    ok "DATABASE_URL present in .env"
  else
    fail "DATABASE_URL not set — export it or add to .env"
    exit 2
  fi
else
  ok "DATABASE_URL present in env"
fi

# ─── Build ───────────────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  step "building backend (tsc)"
  if ! (cd "${REPO_DIR}" && npm run build -w backend) >>"${BACKEND_LOG}" 2>&1; then
    fail "build failed (see ${BACKEND_LOG})"
    exit 3
  fi
  ok "tsc clean"
else
  step "skipping build (SKIP_BUILD=1)"
fi

# ─── Boot backend ────────────────────────────────────────────────────────────
step "starting backend on ${BASE}"

# Sanity: nothing already on the port
if curl -fsS -m 1 "${BASE}/health" >/dev/null 2>&1; then
  fail "something is already responding on ${BASE} — choose another PORT"
  exit 4
fi

(
  cd "${REPO_DIR}"
  PORT="${PORT}" HOST="${HOST}" \
  exec node backend/dist/index.js
) >>"${BACKEND_LOG}" 2>&1 &
BACKEND_PID=$!

# ─── Wait for ready ──────────────────────────────────────────────────────────
step "waiting for /health (timeout ${TIMEOUT_BOOT}s)"
deadline=$(( $(date +%s) + TIMEOUT_BOOT ))
ready=0
while (( $(date +%s) < deadline )); do
  if curl -fsS -m 2 "${BASE}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    fail "backend died during boot"
    exit 5
  fi
  sleep 0.5
done

if (( ready == 0 )); then
  fail "backend did not become ready within ${TIMEOUT_BOOT}s"
  exit 5
fi
ok "backend ready (pid ${BACKEND_PID})"

# ─── Checks ──────────────────────────────────────────────────────────────────
checks_run=0
checks_failed=0

assert_http() {
  local label="$1" method="$2" path="$3" want_status="$4"
  checks_run=$(( checks_run + 1 ))
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' -X "${method}" "${BASE}${path}" || echo "000")
  if [[ "${got}" == "${want_status}" ]]; then
    ok "${label}: ${method} ${path} → ${got}"
  else
    fail "${label}: ${method} ${path} → ${got} (expected ${want_status})"
    checks_failed=$(( checks_failed + 1 ))
  fi
}

assert_json_field() {
  local label="$1" path="$2" jq_filter="$3" want="$4"
  checks_run=$(( checks_run + 1 ))
  local got
  got=$(curl -s "${BASE}${path}" | node -e "
    let buf=''; process.stdin.on('data',c=>buf+=c); process.stdin.on('end',()=>{
      try { const j=JSON.parse(buf); const v=${jq_filter}; process.stdout.write(String(v)); }
      catch(e){ process.stdout.write('PARSE_ERROR'); }
    });" 2>/dev/null || echo "ERR")
  if [[ "${got}" == "${want}" ]]; then
    ok "${label}: ${path} → ${jq_filter} = ${got}"
  else
    fail "${label}: ${path} → ${jq_filter} = ${got} (expected ${want})"
    checks_failed=$(( checks_failed + 1 ))
  fi
}

echo
step "exercising public surface"

assert_http       "health"        GET  "/health"             "200"
assert_http       "auth-bootstrap" GET  "/api/auth/bootstrap" "200"
assert_json_field "bootstrap-shape" "/api/auth/bootstrap" "typeof j.usersExist" "boolean"

# Authed endpoints must reject without a cookie
assert_http       "status-noauth"  GET  "/api/status"         "401"
assert_http       "me-noauth"      GET  "/api/auth/me"        "200"  # returns {user:null}, not 401, by design

# Rate-limit headers should be present on auth endpoints (sess.2818 H1)
echo
step "verifying rate-limit headers on /login"
headers=$(curl -s -i -X POST "${BASE}/api/auth/login" -H 'content-type: application/json' -d '{"email":"x@x","password":"x"}' | tr -d '\r')
# Match RFC draft-7 (`RateLimit-*`), legacy (`X-RateLimit-*`), and lowercase
# variants. `-i` should suffice but be defensive against header normalization.
if echo "${headers}" | grep -qiE '^(x-)?ratelimit'; then
  ok "rate-limit headers present"
else
  warn "rate-limit headers missing (express-rate-limit may need standardHeaders set)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo
if (( checks_failed == 0 )); then
  ok "smoke test passed (${checks_run} checks)"
  exit 0
else
  fail "smoke test failed (${checks_failed}/${checks_run} checks)"
  exit 1
fi
