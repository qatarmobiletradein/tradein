#!/usr/bin/env bash
# =============================================================================
# LOCAL CLOUD EMULATION — the closest thing to staging that runs without a
# Supabase or Railway account. NOT a substitute for the real staging run.
#
#   npm run emulate:staging            (needs Docker, PostgreSQL 16 binaries, openssl)
#
# What runs for real:
#   - the SHIPPED Dockerfile image (built here), started with APP_ENV=staging
#     and the same variables Railway will set; migrations and the staging seed
#     run FROM THE IMAGE (npm run migrate / npm run seed:staging)
#   - PostgreSQL 16 with TLS (certificate verified with DATABASE_SSL_CA) and a
#     Supabase-like privilege model (migrations run as a NON-superuser postgres)
#   - Supabase Auth = the open-source GoTrue image (phone OTP + Send SMS hook for
#     customers; email + password and the "Reset password" e-mail for staff)
#   - PostgREST image for direct-access RLS checks
# What is emulated (tests/staging/local-cloud/gateway.ts):
#   - Supabase's API gateway routing + apikey check, the Storage API (object
#     visibility still decided by the real storage.objects RLS), Twilio's
#     Messages API (to receive the codes) and an SMTP server (to receive the
#     staff password e-mails Supabase Auth sends).
# Then tools/staging/verify-staging.ts runs every group against it.
#
# Everything binds to 127.0.0.1, uses throwaway secrets generated per run,
# fictional data, and is deleted at the end.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$(pwd)"

[[ -n "${DATABASE_URL:-}" ]] && { echo "Refusing: DATABASE_URL is set." >&2; exit 2; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 3; }
PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[[ -x "$PG_BIN/initdb" ]] || { echo "PostgreSQL server binaries not found (set PG_BIN)." >&2; exit 3; }

IMAGE="${QM_IMAGE:-qm-api:staging-emulation}"
GOTRUE_IMAGE="${GOTRUE_IMAGE:-supabase/gotrue:v2.170.0}"
PGRST_IMAGE="${PGRST_IMAGE:-postgrest/postgrest:v12.2.12}"
PGPORT=54331; GOTRUE_PORT=9999; PGRST_PORT=3000; GW_PORT=8443; CTL_PORT=8444; API_PORT=18081; WEB_PORT=8445; SMTP_PORT=2525
WORK="$(mktemp -d /tmp/qm-emul-XXXXXX)"; chmod 755 "$WORK"
CERTS="$WORK/certs"; mkdir -p "$CERTS"
OUT="$ROOT/staging-reports/emulation"; mkdir -p "$OUT"
RUNAS=(); [[ "$(id -u)" == "0" ]] && RUNAS=(runuser -u postgres --)
GW_PID=""

cleanup() {
  set +e
  for c in qm-emul-api qm-emul-gotrue qm-emul-pgrst; do docker rm -f "$c" >/dev/null 2>&1; done
  [[ -n "$GW_PID" ]] && kill "$GW_PID" 2>/dev/null
  [[ -n "${PGDIR:-}" ]] && "${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$PGDIR/data" -m immediate stop >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT
step() { echo; echo "=== $*"; }

# ---------------------------------------------------------------- secrets + TLS
PW="$(openssl rand -hex 16)"
JWT_SECRET="$(openssl rand -hex 32)"
HOOK_SECRET="v1,whsec_$(openssl rand -base64 32)"
TWILIO_SID="AC$(openssl rand -hex 16)"; TWILIO_TOKEN="$(openssl rand -hex 16)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=QM Emulation CA" -keyout "$CERTS/ca.key" -out "$CERTS/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout "$CERTS/server.key" -out "$CERTS/server.csr" 2>/dev/null
printf "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:api.twilio.com\nbasicConstraints=CA:FALSE\n" > "$CERTS/ext.cnf"
openssl x509 -req -in "$CERTS/server.csr" -CA "$CERTS/ca.crt" -CAkey "$CERTS/ca.key" -CAcreateserial -days 1 -extfile "$CERTS/ext.cnf" -out "$CERTS/server.crt" 2>/dev/null
chmod 644 "$CERTS"/*.crt "$CERTS/server.key"
PGDIR="$WORK/pg"; mkdir -p "$PGDIR"
cp "$CERTS/server.key" "$PGDIR/pg.key"; cp "$CERTS/server.crt" "$PGDIR/pg.crt"
[[ "$(id -u)" == "0" ]] && chown -R postgres "$PGDIR"
chmod 600 "$PGDIR/pg.key"
# Node in the driver trusts the workspace proxy CA (if any) AND the emulation CA.
cat "$CERTS/ca.crt" > "$WORK/node-ca.pem"; [[ -n "${NODE_EXTRA_CA_CERTS:-}" && -f "${NODE_EXTRA_CA_CERTS}" ]] && cat "$NODE_EXTRA_CA_CERTS" >> "$WORK/node-ca.pem"

sign() { node --input-type=module -e "import { SignJWT } from 'jose'; const k=new TextEncoder().encode(process.argv[1]); console.log(await new SignJWT({ role: process.argv[2], iss: 'supabase' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt().setExpirationTime('1d').sign(k));" "$JWT_SECRET" "$1"; }
ANON_KEY="$(sign anon)"; SERVICE_KEY="$(sign service_role)"

# ---------------------------------------------------------------- PostgreSQL (TLS)
step "PostgreSQL 16 with TLS and a Supabase-like role model"
echo "$PW" > "$PGDIR/pwfile"; chmod 644 "$PGDIR/pwfile"
"${RUNAS[@]}" "$PG_BIN/initdb" -D "$PGDIR/data" -U supabase_admin --pwfile="$PGDIR/pwfile" --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8 >/dev/null
"${RUNAS[@]}" "$PG_BIN/pg_ctl" -D "$PGDIR/data" -l "$PGDIR/pg.log" -o "-p $PGPORT -k $PGDIR -c listen_addresses=127.0.0.1 -c max_connections=200 -c fsync=off -c ssl=on -c ssl_cert_file=$PGDIR/pg.crt -c ssl_key_file=$PGDIR/pg.key" -w start >/dev/null
ADMIN_URL="postgres://supabase_admin:$PW@127.0.0.1:$PGPORT/postgres"
"${RUNAS[@]}" psql -h "$PGDIR" -p $PGPORT -U supabase_admin -d postgres -q -v pw="$PW" -f "$ROOT/tests/staging/local-cloud/init.sql"

step "Supabase Auth ($GOTRUE_IMAGE) — runs its own migrations into schema auth"
docker run -d --name qm-emul-gotrue --network host -v "$CERTS:/certs:ro" \
  -e SSL_CERT_FILE=/certs/ca.crt \
  -e GOTRUE_API_HOST=127.0.0.1 -e GOTRUE_API_PORT=$GOTRUE_PORT -e PORT=$GOTRUE_PORT \
  -e API_EXTERNAL_URL="https://127.0.0.1:$GW_PORT/auth/v1" -e GOTRUE_SITE_URL="https://staging.example.test" \
  -e GOTRUE_DB_DRIVER=postgres -e GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:$PW@127.0.0.1:$PGPORT/postgres?sslmode=require" \
  -e GOTRUE_JWT_SECRET="$JWT_SECRET" -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_JWT_ADMIN_ROLES=service_role -e GOTRUE_JWT_ISSUER="https://127.0.0.1:$GW_PORT/auth/v1" \
  -e GOTRUE_EXTERNAL_PHONE_ENABLED=true -e GOTRUE_SMS_AUTOCONFIRM=false -e GOTRUE_SMS_OTP_EXP=300 -e GOTRUE_SMS_OTP_LENGTH=6 \
  -e GOTRUE_SMS_PROVIDER=twilio -e GOTRUE_SMS_TWILIO_ACCOUNT_SID=ACunused -e GOTRUE_SMS_TWILIO_AUTH_TOKEN=unused -e GOTRUE_SMS_TWILIO_MESSAGE_SERVICE_SID=MGunused \
  -e GOTRUE_SMS_MAX_FREQUENCY=1s -e GOTRUE_RATE_LIMIT_SMS_SENT=1000 \
  -e GOTRUE_HOOK_SEND_SMS_ENABLED=true -e GOTRUE_HOOK_SEND_SMS_URI="https://127.0.0.1:$GW_PORT/hooks/send-sms" -e GOTRUE_HOOK_SEND_SMS_SECRETS="$HOOK_SECRET" \
  -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true -e GOTRUE_MAILER_AUTOCONFIRM=false -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_LOG_LEVEL=warn \
  -e GOTRUE_PASSWORD_MIN_LENGTH=12 -e GOTRUE_MAILER_OTP_EXP=900 -e GOTRUE_MAILER_OTP_LENGTH=6 \
  -e GOTRUE_SMTP_HOST=127.0.0.1 -e GOTRUE_SMTP_PORT=$SMTP_PORT -e GOTRUE_SMTP_USER=emulation -e GOTRUE_SMTP_PASS=emulation \
  -e GOTRUE_SMTP_ADMIN_EMAIL=no-reply@staging.example.test -e GOTRUE_SMTP_SENDER_NAME="Qatar Mobile (staging)" -e GOTRUE_SMTP_MAX_FREQUENCY=1s \
  -e GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 -e GOTRUE_MAILER_SUBJECTS_RECOVERY="Your Qatar Mobile staff code" \
  -e GOTRUE_MAILER_TEMPLATES_RECOVERY="http://127.0.0.1:$CTL_PORT/templates/recovery" \
  "$GOTRUE_IMAGE" >/dev/null
for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$GOTRUE_PORT/health" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$GOTRUE_PORT/health" >/dev/null || { docker logs qm-emul-gotrue | tail -30; exit 4; }
"${RUNAS[@]}" psql -h "$PGDIR" -p $PGPORT -U supabase_admin -d postgres -q -f "$ROOT/tests/staging/local-cloud/post-auth.sql"
echo "auth ready: $(curl -s "http://127.0.0.1:$GOTRUE_PORT/health")"

step "Build the shipped Dockerfile image"
DOCKERFILE="$ROOT/Dockerfile"; EXTRA=()
if [[ -n "${QM_BUILD_CA_DIR:-}" ]]; then
  # Only for workspaces that intercept TLS: trust their CA during npm ci. The shipped Dockerfile is unchanged.
  sed 's|^FROM ${NODE_IMAGE} AS build$|&\nCOPY --from=ccr ca-bundle.crt /tmp/local-ca.crt\nENV NODE_EXTRA_CA_CERTS=/tmp/local-ca.crt npm_config_cafile=/tmp/local-ca.crt|' "$ROOT/Dockerfile" > "$WORK/Dockerfile"
  DOCKERFILE="$WORK/Dockerfile"; EXTRA=(--build-context "ccr=$QM_BUILD_CA_DIR")
fi
docker build -q --network host "${EXTRA[@]}" -f "$DOCKERFILE" -t "$IMAGE" "$ROOT" >/dev/null
echo "image: $IMAGE ($(docker image inspect "$IMAGE" --format '{{.Size}}' | awk '{printf "%.0f MB", $1/1048576}'))"

DB_URL="postgres://postgres:$PW@127.0.0.1:$PGPORT/postgres"
CA_PEM="$(cat "$CERTS/ca.crt")"
run_image() { docker run --rm --network host -e DATABASE_URL="$DB_URL" -e DATABASE_SSL=require -e DATABASE_SSL_CA="$CA_PEM" "$@"; }

step "TLS to the database is verified (no CA → refused)"
if docker run --rm --network host -e DATABASE_URL="$DB_URL" -e DATABASE_SSL=require "$IMAGE" npm run -s migrate >"$WORK/notls.log" 2>&1; then
  echo "FAIL: connected without the CA"; exit 5
else
  grep -qiE "self.signed|certificate" "$WORK/notls.log" && echo "PASS: refused without the CA: $(grep -iE 'self.signed|certificate' "$WORK/notls.log" | head -1)"
fi

step "Migrations FROM THE IMAGE as the non-superuser postgres role (twice)"
run_image "$IMAGE" npm run -s migrate | tee "$OUT/migrate-1.log"
run_image "$IMAGE" npm run -s migrate | tee "$OUT/migrate-2.log"

step "Staging seed FROM THE IMAGE (APP_ENV=staging)"
run_image -e APP_ENV=staging "$IMAGE" npm run -s seed:staging | tee "$OUT/seed.log"

step "PostgREST ($PGRST_IMAGE)"
docker run -d --name qm-emul-pgrst --network host \
  -e PGRST_DB_URI="postgres://authenticator:$PW@127.0.0.1:$PGPORT/postgres" -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" -e PGRST_SERVER_HOST=127.0.0.1 -e PGRST_SERVER_PORT=$PGRST_PORT -e PGRST_LOG_LEVEL=error \
  "$PGRST_IMAGE" >/dev/null
for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PGRST_PORT/" && break; sleep 1; done

step "Gateway (Supabase API routing + Storage + Twilio emulation)"
GW_PORT=$GW_PORT CTL_PORT=$CTL_PORT SMTP_PORT=$SMTP_PORT GOTRUE_PORT=$GOTRUE_PORT PGRST_PORT=$PGRST_PORT API_PORT=$API_PORT JWT_SECRET="$JWT_SECRET" \
  ANON_KEY="$ANON_KEY" SERVICE_KEY="$SERVICE_KEY" TWILIO_SID="$TWILIO_SID" TWILIO_TOKEN="$TWILIO_TOKEN" \
  TLS_CERT="$CERTS/server.crt" TLS_KEY="$CERTS/server.key" ADMIN_DB_URL="$ADMIN_URL" \
  node --import tsx "$ROOT/tests/staging/local-cloud/gateway.ts" > "$WORK/gateway.log" 2>&1 &
GW_PID=$!
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$CTL_PORT/health" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$CTL_PORT/health" >/dev/null || { cat "$WORK/gateway.log"; exit 6; }

step "API container, APP_ENV=staging, Railway-style variables"
docker run -d --name qm-emul-api --network host --add-host api.twilio.com:127.0.0.1 -v "$CERTS:/certs:ro" \
  -e NODE_EXTRA_CA_CERTS=/certs/ca.crt -e PORT=$API_PORT -e HOST=127.0.0.1 -e APP_ENV=staging -e LOG_LEVEL=info -e TRUST_PROXY_HOPS=1 \
  -e DATABASE_URL="$DB_URL" -e DATABASE_SSL=require -e DATABASE_SSL_CA="$CA_PEM" -e DATABASE_POOL_MAX=10 \
  -e SUPABASE_URL="https://127.0.0.1:$GW_PORT" -e SUPABASE_ANON_KEY="$ANON_KEY" -e SUPABASE_SERVICE_ROLE_KEY="$SERVICE_KEY" \
  -e SUPABASE_JWT_SECRET="$JWT_SECRET" -e SUPABASE_JWT_ISSUER="https://127.0.0.1:$GW_PORT/auth/v1" -e SEND_SMS_HOOK_SECRET="$HOOK_SECRET" \
  -e CORS_ALLOWED_ORIGINS="https://staging.example.test,https://127.0.0.1:$WEB_PORT" \
  -e SMS_PROVIDER=twilio -e TWILIO_ACCOUNT_SID="$TWILIO_SID" -e TWILIO_AUTH_TOKEN="$TWILIO_TOKEN" -e TWILIO_FROM=+15005550006 \
  -e AUTH_RATE_LIMIT_MAX=120 \
  "$IMAGE" >/dev/null
for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$API_PORT/ready" >/dev/null && break; sleep 0.5; done
echo "ready: $(curl -s "http://127.0.0.1:$API_PORT/ready")"

step "Drive: real sign-in for every seeded profile (customers: SMS code; staff: e-mailed code + password), then the full verification"
set +e
NODE_EXTRA_CA_CERTS="$WORK/node-ca.pem" API="http://127.0.0.1:$API_PORT" CTL="http://127.0.0.1:$CTL_PORT" GW="https://127.0.0.1:$GW_PORT" \
  ANON_KEY="$ANON_KEY" JWT_SECRET="$JWT_SECRET" DB_URL="$DB_URL" DB_CA="$CERTS/ca.crt" WORK="$WORK" OUT="$OUT" \
  npx tsx "$ROOT/tests/staging/local-cloud/drive.ts"
DRIVE=$?

step "Browser: the unchanged 3.1 screens, served over HTTPS, signing in through Supabase Auth"
NODE_EXTRA_CA_CERTS="$WORK/node-ca.pem" API="http://127.0.0.1:$API_PORT" CTL="http://127.0.0.1:$CTL_PORT" WEB_PORT=$WEB_PORT \
  TLS_CERT="$CERTS/server.crt" TLS_KEY="$CERTS/server.key" OUT="$OUT" npx tsx "$ROOT/tests/staging/local-cloud/ui.ts"
UI=$?
[[ $UI != 0 ]] && DRIVE=1
set -e

step "Graceful shutdown of the API container (docker stop = SIGTERM)"
docker stop -t 30 qm-emul-api >/dev/null
EXIT_CODE="$(docker inspect qm-emul-api --format '{{.State.ExitCode}}')"
docker logs qm-emul-api > "$OUT/api-container.log" 2>&1
grep -q '"msg":"shutdown complete"' "$OUT/api-container.log" && echo "PASS: shutdown complete, exit code $EXIT_CODE" || echo "FAIL: no clean shutdown (exit $EXIT_CODE)"
# The container log must not contain secrets, codes or tokens.
LEAK=0
for s in "$PW" "$JWT_SECRET" "$TWILIO_TOKEN" "${HOOK_SECRET#v1,}" "$SERVICE_KEY"; do grep -qF -- "$s" "$OUT/api-container.log" && LEAK=1; done
grep -qE 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.' "$OUT/api-container.log" && LEAK=1
[[ $LEAK == 0 ]] && echo "PASS: API log contains no secret, key or JWT" || { echo "FAIL: API log contains a secret or token"; DRIVE=1; }
docker logs qm-emul-gotrue > "$OUT/gotrue.log" 2>&1 || true
exit $DRIVE
