#!/usr/bin/env bash
# Fails if something that looks like a secret is committed. The page's publishable Supabase key is public by design.
cd "$(dirname "$0")/.." || exit 1
PATTERNS='sk-ant-[A-Za-z0-9_-]{20,}|pat-(na|eu)[0-9]-[0-9a-f-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}|GOCSPX-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16}|sb_secret_[A-Za-z0-9_-]{10,}'
hits=$(git ls-files -z | xargs -0 grep -InE "$PATTERNS" 2>/dev/null | grep -v "scripts/secret-scan.sh" || true)
if [ -n "$hits" ]; then
  echo "Possible secrets found:"; echo "$hits" | sed -E 's/(.{80}).*/\1.../'
  exit 1
fi
echo "no secrets found"
