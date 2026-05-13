#!/usr/bin/env bash
#
# backup-db.sh — снимает бэкап Postgres + аплоадов Outline.
#
# Куда:    /opt/outline/backups/  (рядом с docker-compose.yml)
# Что:     db-YYYY-MM-DD-HHMMSS.sql.gz   (pg_dump --clean --if-exists)
#          uploads-YYYY-MM-DD-HHMMSS.tar.gz   (содержимое /opt/outline/data)
# Ротация: храним 14 последних дневных + 8 еженедельных (воскресенья)
#
# Подходит для запуска из cron:
#   0 3 * * *  /opt/outline/src/backup-db.sh >> /var/log/outline-backup.log 2>&1
#
# Восстановление:  ./restore-db.sh /path/to/db-XXXX.sql.gz

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${HERE}/docker-compose.yml" ]]; then
  ROOT="${HERE}"
elif [[ -f "${HERE}/../docker-compose.yml" ]]; then
  ROOT="$(cd "${HERE}/.." && pwd)"
else
  echo "✗ docker-compose.yml не найден" >&2
  exit 1
fi
cd "${ROOT}"

BACKUP_DIR="${ROOT}/backups"
mkdir -p "${BACKUP_DIR}"

TS="$(date +%Y-%m-%d-%H%M%S)"
DOW="$(date +%u)"  # 1=Mon … 7=Sun

DB_FILE="${BACKUP_DIR}/db-${TS}.sql.gz"
UPLOADS_FILE="${BACKUP_DIR}/uploads-${TS}.tar.gz"

log() { printf '%s  %s\n' "$(date +'%F %T')" "$*"; }

# -----------------------------------------------------------------------------
# 1. БД через pg_dump в контейнере. --clean/--if-exists даёт идемпотентный
#    restore (снесёт таблицы перед накатом).
# -----------------------------------------------------------------------------
log "→ pg_dump → ${DB_FILE}"
docker compose exec -T postgres \
  pg_dump --clean --if-exists --no-owner -U outline outline \
  | gzip -9 > "${DB_FILE}"
DB_SIZE=$(du -h "${DB_FILE}" | awk '{print $1}')
log "✓ db backup: ${DB_SIZE}"

# -----------------------------------------------------------------------------
# 2. Аплоады (FILE_STORAGE=local → /opt/outline/data). Если пусто — пропускаем.
# -----------------------------------------------------------------------------
if [[ -d "${ROOT}/data" ]] && [[ -n "$(ls -A "${ROOT}/data" 2>/dev/null)" ]]; then
  log "→ tar uploads → ${UPLOADS_FILE}"
  tar -C "${ROOT}" -czf "${UPLOADS_FILE}" data/
  UP_SIZE=$(du -h "${UPLOADS_FILE}" | awk '{print $1}')
  log "✓ uploads backup: ${UP_SIZE}"
else
  log "skip uploads: ${ROOT}/data пуст"
fi

# -----------------------------------------------------------------------------
# 3. Метка «последний воскресный бэкап» (мягкий weekly через симлинк).
# -----------------------------------------------------------------------------
if [[ "${DOW}" == "7" ]]; then
  ln -sfn "$(basename "${DB_FILE}")" "${BACKUP_DIR}/db-weekly-latest.sql.gz"
  log "→ weekly link → db-weekly-latest.sql.gz"
fi

# -----------------------------------------------------------------------------
# 4. Ротация:
#    - daily (db-YYYY-MM-DD-*): держим 14 последних
#    - weekly identifier — пока не используем, оставляем все weekly через симлинк
# -----------------------------------------------------------------------------
log "→ ротация (оставляем 14 последних dump-ов)"
ls -1t "${BACKUP_DIR}"/db-2*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -v
ls -1t "${BACKUP_DIR}"/uploads-2*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -v

log "done. files in ${BACKUP_DIR}: $(ls -1 "${BACKUP_DIR}" | wc -l)"
