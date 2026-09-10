#!/usr/bin/env bash
# dev-site.sh — launch the local dev stack against one site's workspace.
#
# Each Site keeps its local Site data in .sites/<site>/ (git-ignored):
#   .sites/<site>/data/cms.db   — the site's SQLite database
#   .sites/<site>/uploads/      — media, fonts, published artefacts
#
# Workspaces are disposable, NOT backups: before a site launches, its
# workspace is the content-authoring place (Content authority — see
# docs/adr/0003); after launch the production instance owns the content and
# local workspaces are scratch (pull a production snapshot over one to debug
# with real data — see docs/deployment/local-workspaces.md).
#
# Usage:
#   scripts/dev-site.sh <site>     # start (or restart) the dev server for <site>
#   scripts/dev-site.sh --list     # show known sites and their ports
#
# The port mirrors the production mapping (ditexpo=3001 … site4=3004), so
# several sites can run side by side locally exactly as they do on the VPS.
# Reset one workspace with: bun run db:drop --site <site>

set -euo pipefail
cd "$(dirname "$0")/.."

SITES_DIR=.sites

# site:port pairs — keep in sync with deploy/<site>/compose.yml host ports.
declare -A KNOWN_PORTS=( [ditexpo]=3001 [difgc]=3002 [site3]=3003 [site4]=3004 )

if [[ "${1:-}" == "--list" || -z "${1:-}" ]]; then
  echo "Known sites:"
  for site in ditexpo difgc site3 site4; do
    echo "  $site  → http://127.0.0.1:${KNOWN_PORTS[$site]}  (${SITES_DIR}/${site}/)"
  done
  [[ -n "${1:-}" ]] && exit 0
  echo "Usage: scripts/dev-site.sh <site>"
  exit 1
fi

SITE=$1
PORT=${KNOWN_PORTS[$SITE]:-}
if [[ -z "$PORT" ]]; then
  echo "Unknown site: $SITE" >&2
  echo "Known sites: ${!KNOWN_PORTS[*]}" >&2
  exit 1
fi

DB_PATH="$SITES_DIR/$SITE/data/cms.db"
UPLOADS_DIR="$SITES_DIR/$SITE/uploads"
mkdir -p "$(dirname "$DB_PATH")" "$UPLOADS_DIR"

echo "[dev-site] site:     $SITE"
echo "[dev-site] database: $DB_PATH"
echo "[dev-site] uploads:  $UPLOADS_DIR"
echo "[dev-site] url:      http://127.0.0.1:$PORT"

exec env \
  DATABASE_URL="sqlite:$DB_PATH" \
  UPLOADS_DIR="$UPLOADS_DIR" \
  PORT="$PORT" \
  bun run dev
