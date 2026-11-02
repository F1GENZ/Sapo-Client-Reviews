#!/usr/bin/env bash
set -euo pipefail
umask 077

DB_NAME="${SAPO_DB_NAME:-sapo_reviews_db}"
BACKUP_DIR="${SAPO_BACKUP_DIR:-/var/backups/sapo-reviews}"
RETENTION_DAYS="${SAPO_BACKUP_RETENTION_DAYS:-14}"
PG_OS_USER=postgres
STATUS_FILE="$BACKUP_DIR/last-run.status"
TABLES_SQL="select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"
  logger -t sapo-reviews-db-backup -- "$*" || true
}

pg() {
  runuser -u "$PG_OS_USER" -- "$@"
}

write_status() {
  printf '%s %s %s\n' "$1" "$(date -u +%FT%TZ)" "$2" > "$STATUS_FILE"
}

backup() {
  install -d -m 700 -o root -g root "$BACKUP_DIR"
  local final partial bytes
  final="$BACKUP_DIR/$DB_NAME-$(date -u +%Y%m%dT%H%M%SZ).dump"
  partial="$final.partial"

  trap 'rm -f "$partial"; write_status FAIL "dump of $DB_NAME failed"; log "FAIL dump of $DB_NAME"' ERR
  pg pg_dump --format=custom "$DB_NAME" > "$partial"
  [ -s "$partial" ]
  pg pg_restore --list < "$partial" > /dev/null
  mv "$partial" "$final"
  trap - ERR

  bytes=$(stat -c %s "$final")
  write_status OK "$(basename "$final") ${bytes}B"
  log "OK $(basename "$final") $bytes bytes"

  # Pruning runs only after a verified dump, so a failing database never erodes the history.
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name "$DB_NAME-*.dump" -o -name "$DB_NAME-*.partial" \) \
    -mtime "+$((RETENTION_DAYS - 1))" -delete
}

restore_test() {
  local dump="${1:-}" scratch tables_live tables_restored table live restored
  if [ -z "$dump" ]; then
    dump=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name "$DB_NAME-*.dump" | sort | tail -n 1)
  fi
  if [ -z "$dump" ] || [ ! -s "$dump" ]; then
    log "FAIL restore test: no dump found in $BACKUP_DIR"
    exit 1
  fi

  scratch="${DB_NAME}_restoretest_$(date -u +%s)"
  trap 'pg dropdb --if-exists "$scratch" > /dev/null 2>&1 || true' EXIT
  pg createdb "$scratch"
  pg pg_restore --exit-on-error --no-owner --no-privileges --dbname="$scratch" < "$dump"

  tables_live=$(pg psql -d "$DB_NAME" -Atc "$TABLES_SQL")
  tables_restored=$(pg psql -d "$scratch" -Atc "$TABLES_SQL")
  if [ "$tables_live" != "$tables_restored" ]; then
    log "FAIL restore test: table set differs between $DB_NAME and the restored copy"
    exit 1
  fi
  while IFS= read -r table; do
    [ -n "$table" ] || continue
    live=$(pg psql -d "$DB_NAME" -Atc "select count(*) from \"$table\"")
    restored=$(pg psql -d "$scratch" -Atc "select count(*) from \"$table\"")
    printf '%-40s live=%s restored=%s\n' "$table" "$live" "$restored"
  done <<< "$tables_restored"

  pg dropdb "$scratch"
  trap - EXIT
  log "OK restore test of $(basename "$dump") passed; scratch database $scratch dropped"
}

case "${1:-backup}" in
  backup) backup ;;
  restore-test) restore_test "${2:-}" ;;
  *) echo "usage: $0 [backup | restore-test [dump-file]]" >&2; exit 2 ;;
esac
