#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/pull_nico_latest.sh --series-url URL --output-dir DIR [options]

Options:
  --series-url URL     Nico Manga series URL, e.g. https://manga.nicovideo.jp/comic/47265
  --output-dir DIR     Directory where extracted ZIP files are stored
  --account-file PATH  Stored Nico account file (default: cli/cookies/nico-manga-account.json)
  --cookie-file PATH   Stored Nico cookie jar (default: cli/cookies/nico-manga.json)
  --state-file PATH    State file used to skip already-downloaded episodes
  --dry-run            Resolve the latest episode and print what would run
  --force              Ignore the state file and extract anyway
  -h, --help           Show this help

Environment:
  NICO_ACCOUNT_EMAIL     Existing Nico login email used for first-time bootstrap
  NICO_ACCOUNT_PASSWORD  Existing Nico login password used for first-time bootstrap
  AUTOMATION_EMAIL       Gmail mailbox watched for Nico confirmation codes
  ME1_APP_PASS           Gmail app password for IMAP access

Notes:
  - First run is most reliable when you provide NICO_ACCOUNT_EMAIL + NICO_ACCOUNT_PASSWORD.
  - After a successful run, the helper stores account metadata automatically and refreshes cookies as needed.
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERIES_URL=""
OUTPUT_DIR=""
ACCOUNT_FILE="cli/cookies/nico-manga-account.json"
COOKIE_FILE="cli/cookies/nico-manga.json"
STATE_FILE=""
DRY_RUN="false"
FORCE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --series-url)
      SERIES_URL="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --account-file)
      ACCOUNT_FILE="${2:-}"
      shift 2
      ;;
    --cookie-file)
      COOKIE_FILE="${2:-}"
      shift 2
      ;;
    --state-file)
      STATE_FILE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --force)
      FORCE="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$SERIES_URL" || -z "$OUTPUT_DIR" ]]; then
  usage >&2
  exit 1
fi

cd "$ROOT_DIR"

mkdir -p "$OUTPUT_DIR"
if [[ -z "$STATE_FILE" ]]; then
  STATE_FILE="$OUTPUT_DIR/.latest_episode_url"
fi

if [[ ! -f "node_modules/imapflow/package.json" || ! -f "node_modules/puppeteer/package.json" ]]; then
  echo "Installing Bun dependencies..."
  bun install --frozen-lockfile
fi

echo "Building handlers..."
bun run build

eval "$(bun cli/latest.ts --reader nico-manga --seriesUrl "$SERIES_URL" --format shell)"

if [[ -z "${LATEST_FREE_URL:-}" ]]; then
  echo "Resolver did not return a latest free episode URL." >&2
  exit 1
fi

echo "Resolved latest free episode:"
echo "  Series:  ${SERIES_TITLE:-unknown}"
echo "  Episode: ${LATEST_FREE_TITLE:-unknown}"
echo "  URL:     ${LATEST_FREE_URL}"

if [[ "$FORCE" != "true" && -f "$STATE_FILE" ]]; then
  PREVIOUS_URL="$(<"$STATE_FILE")"
  if [[ "$PREVIOUS_URL" == "$LATEST_FREE_URL" ]]; then
    echo "State file already points at the latest episode. Skipping extraction."
    exit 0
  fi
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "Dry run complete; no extraction performed."
  exit 0
fi

if [[ ! -f "$ACCOUNT_FILE" && ( -z "${NICO_ACCOUNT_EMAIL:-}" || -z "${NICO_ACCOUNT_PASSWORD:-}" ) ]]; then
  echo "Missing Nico account bootstrap." >&2
  echo "Set NICO_ACCOUNT_EMAIL and NICO_ACCOUNT_PASSWORD for the first successful run," >&2
  echo "or place an existing account file at $ACCOUNT_FILE." >&2
  exit 2
fi

before_list="$(mktemp)"
after_list="$(mktemp)"
trap 'rm -f "$before_list" "$after_list"' EXIT

compgen -G "$OUTPUT_DIR"/*.zip | LC_ALL=C sort >"$before_list" || true

scrape_cmd=(
  bun
  cli/nico-account.ts
  scrape
  --url "$LATEST_FREE_URL"
  --watchUrl "$LATEST_FREE_URL"
  --out "$OUTPUT_DIR"
  --accountFile "$ACCOUNT_FILE"
  --cookieFile "$COOKIE_FILE"
)

if [[ -n "${NICO_ACCOUNT_EMAIL:-}" ]]; then
  scrape_cmd+=(--accountEmail "$NICO_ACCOUNT_EMAIL")
fi

if [[ -n "${NICO_ACCOUNT_PASSWORD:-}" ]]; then
  scrape_cmd+=(--password "$NICO_ACCOUNT_PASSWORD")
fi

echo "Starting Nico extraction..."
"${scrape_cmd[@]}"

compgen -G "$OUTPUT_DIR"/*.zip | LC_ALL=C sort >"$after_list" || true
new_zip="$(comm -13 "$before_list" "$after_list" | tail -n 1 || true)"

if [[ -z "$new_zip" ]]; then
  new_zip="$(ls -1t "$OUTPUT_DIR"/*.zip 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$new_zip" ]]; then
  echo "Extraction completed but no ZIP file was found in $OUTPUT_DIR." >&2
  exit 1
fi

echo "Verifying $new_zip ..."
bun cli/verify.ts --input "$new_zip"

printf '%s\n' "$LATEST_FREE_URL" >"$STATE_FILE"

{
  printf 'SERIES_URL=%q\n' "$SERIES_URL"
  printf 'SERIES_TITLE=%q\n' "${SERIES_TITLE:-}"
  printf 'LATEST_FREE_URL=%q\n' "${LATEST_FREE_URL:-}"
  printf 'LATEST_FREE_TITLE=%q\n' "${LATEST_FREE_TITLE:-}"
  printf 'LATEST_LISTED_URL=%q\n' "${LATEST_LISTED_URL:-}"
  printf 'LATEST_LISTED_TITLE=%q\n' "${LATEST_LISTED_TITLE:-}"
  printf 'VERIFIED_ZIP=%q\n' "$new_zip"
  printf 'RESOLVED_AT=%q\n' "${RESOLVED_AT:-}"
} >"$OUTPUT_DIR/latest_episode.env"

echo "Done."
