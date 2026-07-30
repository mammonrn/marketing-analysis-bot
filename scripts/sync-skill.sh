#!/usr/bin/env bash
#
# Sync the thai-data-analyst skill into this repo (spec §4).
#
# The spec requires that any edit to the skill in the claude.ai project is copied
# here before redeploying, because the bot's system prompt IS these files. This
# script copies them byte-for-byte and records hashes in MANIFEST.json so a drift
# is visible in `git diff` rather than discovered from a wrong answer.
#
# Usage:
#   ./scripts/sync-skill.sh [SOURCE_DIR]
#
# SOURCE_DIR defaults to the path Claude Code exposes user skills at.

set -euo pipefail

SRC="${1:-/mnt/skills/user/thai-data-analyst}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/skills/thai-data-analyst"

FILES=(
  "SKILL.md"
  "references/casino-metrics.md"
  "references/u89-metrics.md"
  "references/88fed-metrics.md"
  "references/new-member-quality.md"
  "references/deposit-count-distribution.md"
  "references/brand-game-value.md"
  "references/vip-members.md"
  "references/fraud-anomaly-detection.md"
)

if [[ ! -d "$SRC" ]]; then
  echo "❌ ไม่พบ source dir: $SRC" >&2
  echo "   ระบุ path เอง เช่น: ./scripts/sync-skill.sh ~/Downloads/thai-data-analyst" >&2
  exit 1
fi

mkdir -p "$DEST/references"

copied=0
unchanged=0
missing=0

for rel in "${FILES[@]}"; do
  src_file="$SRC/$rel"
  dest_file="$DEST/$rel"

  if [[ ! -f "$src_file" ]]; then
    printf '  ⚠️  ไม่มีใน source: %s\n' "$rel"
    missing=$((missing + 1))
    continue
  fi

  if [[ -f "$dest_file" ]] && cmp -s "$src_file" "$dest_file"; then
    printf '  =   เหมือนเดิม: %s\n' "$rel"
    unchanged=$((unchanged + 1))
    continue
  fi

  cp "$src_file" "$dest_file"
  printf '  ✅  คัดลอก:    %s\n' "$rel"
  copied=$((copied + 1))
done

# Manifest doubles as the sync receipt: what was copied, and from where.
{
  printf '{\n'
  printf '  "syncedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "source": "%s",\n' "$SRC"
  printf '  "files": {\n'
  first=1
  for rel in "${FILES[@]}"; do
    [[ -f "$DEST/$rel" ]] || continue
    hash="$(sha256sum "$DEST/$rel" | cut -d' ' -f1)"
    bytes="$(wc -c < "$DEST/$rel")"
    [[ $first -eq 0 ]] && printf ',\n'
    printf '    "%s": { "bytes": %d, "sha256": "%s" }' "$rel" "$bytes" "$hash"
    first=0
  done
  printf '\n  }\n}\n'
} > "$DEST/MANIFEST.json"

echo
echo "สรุป: คัดลอก $copied ไฟล์, เหมือนเดิม $unchanged ไฟล์, ขาด $missing ไฟล์"
echo

node "$REPO_ROOT/scripts/check-skill.mjs"

if [[ $copied -gt 0 ]]; then
  cat <<'EOF'

📌 ขั้นตอนถัดไป (อย่าลืม — system prompt เปลี่ยนแล้ว):
   1. git add skills/ && git commit -m "sync: update thai-data-analyst skill files"
   2. git push
   3. บน VPS: git pull && pm2 restart ads-analytics-bot
      (ต้อง restart เพราะ system prompt ถูก cache ไว้ใน process)
EOF
fi
