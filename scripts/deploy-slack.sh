#!/usr/bin/env bash
# Deploy the slack-notify edge function to Supabase.
#
# Before running this script:
#   1. Create a Personal Access Token at https://supabase.com/dashboard/account/tokens
#      and run: supabase login --token <your-pat>   (or just `supabase login`)
#   2. Export the secrets this script needs:
#         export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
#         export WEBHOOK_SECRET="$(openssl rand -hex 32)"
#
# Usage (from repo root):
#   ./scripts/deploy-slack.sh

set -euo pipefail

PROJECT_REF="kohnakdevwfudzgfjmab"
SUPABASE="./node_modules/.bin/supabase"

if [[ -z "${SLACK_WEBHOOK_URL:-}" ]]; then
  echo "❌ SLACK_WEBHOOK_URL is not set. Export it before running:"
  echo '   export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."'
  exit 1
fi

if [[ -z "${WEBHOOK_SECRET:-}" ]]; then
  echo "⚠️  WEBHOOK_SECRET not set — generating one now."
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  echo "   Generated: $WEBHOOK_SECRET"
  echo "   👉 Save this — you'll paste it into the Supabase DB Webhook config in step 3 below."
fi

echo "▶️  Linking project…"
$SUPABASE link --project-ref "$PROJECT_REF"

echo "▶️  Setting secrets…"
$SUPABASE secrets set \
  SLACK_WEBHOOK_URL="$SLACK_WEBHOOK_URL" \
  WEBHOOK_SECRET="$WEBHOOK_SECRET"

echo "▶️  Deploying slack-notify…"
$SUPABASE functions deploy slack-notify --no-verify-jwt

echo ""
echo "✅ Edge function deployed."
echo ""
echo "➡️  Final step (do this in the Supabase dashboard):"
echo "   Database → Webhooks → Create a new hook"
echo "   • Name:         submissions-to-slack"
echo "   • Table:        public.submissions"
echo "   • Events:       Insert only"
echo "   • Type:         Supabase Edge Function"
echo "   • Function:     slack-notify"
echo "   • HTTP Header:  Authorization = Bearer $WEBHOOK_SECRET"
