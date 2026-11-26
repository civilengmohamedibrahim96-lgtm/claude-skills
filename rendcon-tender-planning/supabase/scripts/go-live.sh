#!/usr/bin/env bash
# Redcon Tender Planning – one-time server setup.
#
# Run from rendcon-tender-planning/supabase on a computer with Node 22:
#   cp scripts/golive.env.example scripts/golive.env   # then fill it in
#   bash scripts/go-live.sh
#
# It links the Supabase project, creates the database, stores the function
# secrets, deploys the three functions and adds the first admin.
# Secrets it generates (cron secret, push keys) are written to
# scripts/golive.generated.env – keep that file private (it is git-ignored).
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=scripts/golive.env
GEN_FILE=scripts/golive.generated.env
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE – copy scripts/golive.env.example and fill it in."; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

need() { [ -n "${!1:-}" ] || { echo "Please set $1 in $ENV_FILE"; exit 1; }; }
for v in SUPABASE_PROJECT_REF APP_URL ADMIN_NAME ADMIN_EMAIL; do need "$v"; done
# Outlook reading (mail-sync) needs these three; they can be added later with
# `supabase secrets set`. Without them the board and reminders still work.
for v in GEMINI_API_KEY COMPOSIO_API_KEY COMPOSIO_CONNECTED_ACCOUNT_ID; do
  [ -n "${!v:-}" ] || echo "Note: $v is empty, so reading Outlook emails stays off for now."
done
APP_TIMEZONE=${APP_TIMEZONE:-Africa/Cairo}
GEMINI_MODEL=${GEMINI_MODEL:-gemini-3.5-flash-lite}
VAPID_SUBJECT=${VAPID_SUBJECT:-mailto:$ADMIN_EMAIL}

SB="npx --yes supabase@latest"

echo "== 1/6 Generating secrets (kept if already generated)"
if [ -f "$GEN_FILE" ]; then
  set -a; . "$GEN_FILE"; set +a
else
  CRON_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  KEYS=$(npx --yes web-push@3.6.7 generate-vapid-keys --json)
  VAPID_PUBLIC_KEY=$(node -e "console.log(JSON.parse(process.argv[1]).publicKey)" "$KEYS")
  VAPID_PRIVATE_KEY=$(node -e "console.log(JSON.parse(process.argv[1]).privateKey)" "$KEYS")
  umask 077
  printf 'CRON_SECRET=%s\nVAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\n' "$CRON_SECRET" "$VAPID_PUBLIC_KEY" "$VAPID_PRIVATE_KEY" > "$GEN_FILE"
fi

echo "== 2/6 Signing in to Supabase and linking the project (a browser window may open)"
$SB login
$SB link --project-ref "$SUPABASE_PROJECT_REF"

echo "== 3/6 Creating the database (migrations)"
$SB db push

echo "== 4/6 Storing function secrets"
SECRETS_TMP=$(mktemp)
trap 'rm -f "$SECRETS_TMP"' EXIT
{
  echo "CRON_SECRET=$CRON_SECRET"
  echo "APP_URL=$APP_URL"
  echo "APP_TIMEZONE=$APP_TIMEZONE"
  [ -n "${GEMINI_API_KEY:-}" ] && echo "GEMINI_API_KEY=$GEMINI_API_KEY"
  echo "GEMINI_MODEL=$GEMINI_MODEL"
  [ -n "${COMPOSIO_API_KEY:-}" ] && echo "COMPOSIO_API_KEY=$COMPOSIO_API_KEY"
  [ -n "${COMPOSIO_CONNECTED_ACCOUNT_ID:-}" ] && echo "COMPOSIO_CONNECTED_ACCOUNT_ID=$COMPOSIO_CONNECTED_ACCOUNT_ID"
  [ -n "${COMPOSIO_ARG_MAP:-}" ] && echo "COMPOSIO_ARG_MAP=$COMPOSIO_ARG_MAP"
  echo "VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY"
  echo "VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY"
  echo "VAPID_SUBJECT=$VAPID_SUBJECT"
} > "$SECRETS_TMP"
$SB secrets set --env-file "$SECRETS_TMP"

echo "== 5/6 Deploying the server functions"
$SB functions deploy mail-sync --no-verify-jwt
$SB functions deploy send-reminders --no-verify-jwt
$SB functions deploy mail-review

echo "== 6/6 First admin and scheduler secrets"
SQL_FILE=$(mktemp)
cat > "$SQL_FILE" <<SQL
insert into public.people (name, email, role, board_order, has_column)
values ('$(printf "%s" "$ADMIN_NAME" | sed "s/'/''/g")', lower('$ADMIN_EMAIL'), 'admin', 0, false)
on conflict do nothing;
select vault.create_secret('https://$SUPABASE_PROJECT_REF.supabase.co/functions/v1', 'rendcon_functions_url')
  where not exists (select 1 from vault.secrets where name = 'rendcon_functions_url');
select vault.create_secret('$CRON_SECRET', 'rendcon_cron_secret')
  where not exists (select 1 from vault.secrets where name = 'rendcon_cron_secret');
SQL
if [ -n "${SUPABASE_DB_URL:-}" ] && command -v psql >/dev/null; then
  psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$SQL_FILE"
else
  echo
  echo "Paste this into Supabase → SQL Editor and press Run:"
  echo "--------------------------------------------------------"
  cat "$SQL_FILE"
  echo "--------------------------------------------------------"
fi
rm -f "$SQL_FILE"

cat <<DONE

Server setup finished.

Still to do in the Supabase dashboard:
  • Authentication → Hooks → Before User Created → public.hook_before_user_created → Save
  • Authentication → URL Configuration → Site URL: $APP_URL (also add it to Redirect URLs)

Cloudflare Pages environment variables:
  VITE_SUPABASE_URL      = https://$SUPABASE_PROJECT_REF.supabase.co
  VITE_SUPABASE_ANON_KEY = (Supabase → Project Settings → API → anon public key)
  VITE_VAPID_PUBLIC_KEY  = $VAPID_PUBLIC_KEY
  NODE_VERSION           = 22
DONE
