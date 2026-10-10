#!/usr/bin/env bash
# Account Copilot smoke test. Run: bash scripts/smoke.sh
# Checks security, the public and owner paths, and the scheduled jobs. Never prints keys. Costs no credits.
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BASE="https://tecgblsoylrshcqneevf.supabase.co/functions/v1"
KEY="sb_publishable_V2QMkeCD8XuuoGkz_sVT5Q_4klZp394"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  \033[32mPASS\033[0m %s\n" "$1"; }
bad() { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
expect() { [ "$2" = "$3" ] && ok "$1" || bad "$1 (got $2, wanted $3)"; }
post() { curl -s -m 60 -o /tmp/smoke_body -w "%{http_code}" -X POST "$BASE/$1" -H "Content-Type: application/json" -H "apikey: $KEY" "${@:3}" -d "$2"; }
own()  { post "$1" "$2" -H "x-admin-key: $ADMIN_KEY"; }
field() { python3 -c "import json;d=json.load(open('/tmp/smoke_body'));print($1)" 2>/dev/null; }

echo "Security"
c=$(curl -s -i -X OPTIONS "$BASE/queue" -H "Origin: https://copilot.f1rstword.com" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: x-admin-key,content-type,apikey,authorization" | grep -ci "access-control-allow-headers:.*x-admin-key")
expect "browser may send the owner key (CORS)" "$c" "1"
for f in research-account queue people; do expect "$f rejects calls with no credentials" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/$f -d '{}')" "401"; done
for f in signal-scan meeting-brief daily-digest discover crm-sync; do expect "$f rejects strangers" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/$f -H 'Content-Type: application/json' -d '{}')" "401"; done
expect "wrong owner key is treated as public" "$(post queue '{"action":"outcome","kind":"contacted","account_id":"00000000-0000-0000-0000-000000000000"}' -H 'x-admin-key: wrong')" "200"
expect "  ...and only gets a dry run" "$(field "d.get('mode')")" "dry_run"
expect "public cannot enrich companies" "$(post queue '{"action":"enrich_companies"}')" "403"
expect "public cannot push to HubSpot" "$(post people '{"action":"push","account_id":"00000000-0000-0000-0000-000000000000"}')" "200"
expect "  ...it is a dry run" "$(field "d.get('mode')")" "dry_run"

echo "Public paths"
expect "Today loads" "$(post queue '{"action":"today"}')" "200"
n=$(field "len(d['items'])"); [ "${n:-0}" -ge 0 ] && ok "Today has $n items"
pub_email=$(field "' '.join((c.get('email') or '') for i in d['items'] for c in i['contacts'])")
echo "$pub_email" | grep -qE "[A-Za-z0-9._-]+@" && echo "$pub_email" | grep -qvE "\*\*\*@" && bad "public Today leaks a full email" || ok "public Today shows no full emails"
expect "Queue loads" "$(post queue '{"action":"list"}')" "200"
expect "ICP playbook loads" "$(post queue '{"action":"icp"}')" "200"
expect "bad domain is rejected" "$(post research-account '{"domain":"not a domain"}')" "400"
expect "null body does not crash" "$(post queue 'null')" "400"

echo "Owner paths"
expect "owner key is accepted" "$(own people '{"action":"status"}')" "200"
expect "  ...as admin" "$(field "d.get('admin')")" "True"
expect "owner Today loads" "$(own queue '{"action":"today"}')" "200"
expect "digest preview builds" "$(own daily-digest '{"dry":true}' )" "200"
python3 - <<'PY' 2>/dev/null && ok "digest preview has a plain-text and an HTML version" || bad "digest preview is missing a version"
import json; d=json.load(open('/tmp/smoke_body')); assert d.get('html','').startswith('<!doctype html>') and 'Good morning' in d['body']
PY

expect "meetings list loads" "$(post queue '{"action":"meetings"}')" "200"
expect "  ...public view carries no emails or notes" "$(field "any(m.get('email') or m.get('notes') or m.get('brief') for k in ('needs','upcoming','done') for m in d[k])")" "False"
expect "public cannot save a debrief" "$(post queue '{"action":"debrief","meeting_id":"00000000-0000-0000-0000-000000000000","outcome":"went_well","sig":"bad"}')" "200"
expect "  ...it is a dry run" "$(field "d.get('mode')")" "dry_run"
expect "setup view loads" "$(post queue '{"action":"setup"}')" "200"
expect "public cannot save the profile" "$(post queue '{"action":"profile_save","profile":{}}')" "200"
expect "  ...it is a dry run" "$(field "d.get('mode')")" "dry_run"

echo; echo "Result: $PASS passed, $FAIL failed"; rm -f /tmp/smoke_body
[ "$FAIL" = "0" ]
