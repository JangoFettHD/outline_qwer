#!/usr/bin/env bash
#
# backup-db.sh — полный бекап Outline: Postgres + аплоады + конфиги,
# с валидацией, заливкой в S3, ротацией и email-отчётом.
#
# Что снимает:
#   db-YYYY-MM-DD-HHMMSS.sql.gz       pg_dump --clean --if-exists
#   uploads-YYYY-MM-DD-HHMMSS.tar.gz  содержимое /opt/outline/data
#   config-YYYY-MM-DD-HHMMSS.tar.gz   .env, docker-compose.yml, nginx vhost,
#                                     cron (содержит секреты — в S3, НЕ на почту)
#
# Валидация:
#   - gunzip -t / tar -tzf на архивах
#   - восстановление дампа во временную БД outline_verify внутри контейнера
#     postgres + проверка числа таблиц (реальное доказательство рестора)
#
# S3 (rclone remote "twc", конфиг в ~/.config/rclone/rclone.conf):
#   daily/    — заливается каждый день, хранится 30 дней
#   monthly/  — заливается 1-го числа, хранится 400 дней
#
# Email-отчёт: backup-email.py (рядом со скриптом), SMTP-конфиг и адресаты
# из /opt/outline/.backup-env. Малые архивы (< 20 МБ суммарно) идут вложением.
#
# Cron:  0 3 * * * root /opt/outline/backup-db.sh >> /var/log/outline-backup.log 2>&1
# Восстановление:   ./restore-db.sh backups/db-XXXX.sql.gz

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${HERE}/docker-compose.yml" ]]; then
  ROOT="${HERE}"
  SRC_DIR="${HERE}/src"
elif [[ -f "${HERE}/../docker-compose.yml" ]]; then
  ROOT="$(cd "${HERE}/.." && pwd)"
  SRC_DIR="${HERE}"
else
  echo "✗ docker-compose.yml не найден" >&2
  exit 1
fi
cd "${ROOT}"

BACKUP_DIR="${ROOT}/backups"
mkdir -p "${BACKUP_DIR}"

TS="$(date +%Y-%m-%d-%H%M%S)"
DOM="$(date +%d)"  # день месяца: 01 → monthly

DB_FILE="${BACKUP_DIR}/db-${TS}.sql.gz"
UPLOADS_FILE="${BACKUP_DIR}/uploads-${TS}.tar.gz"
CONFIG_FILE="${BACKUP_DIR}/config-${TS}.tar.gz"

log() { printf '%s  %s\n' "$(date +'%F %T')" "$*"; }

# ── Конфиг S3 + SMTP (для cron-окружения) ───────────────────────────────────
# Файл создаётся вручную на сервере, формат KEY=VALUE, chmod 600.
BACKUP_ENV="${ROOT}/.backup-env"
if [[ -f "${BACKUP_ENV}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${BACKUP_ENV}"
  set +a
fi
S3_REMOTE="${S3_REMOTE:-twc}"
S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-outline-backups}"

# ── Отчёт при падении ────────────────────────────────────────────────────────
STATUS="OK"
FAIL_REASON=""
notify_failure() {
  STATUS="FAILED"
  FAIL_REASON="строка $1: команда завершилась с ошибкой"
  log "✗ BACKUP FAILED at line $1"
  send_report || true
  exit 1
}
trap 'notify_failure $LINENO' ERR

# Presigned-ссылка на объект в S3 (живёт 7 дней). Пустая строка при ошибке.
s3_link() {
  local file="$1"
  [[ -z "${S3_BUCKET}" || ! -f "${file}" ]] && return 0
  rclone link "${S3_REMOTE}:${S3_BUCKET}/${S3_PREFIX}/${S3_CLASS:-daily}/$(basename "${file}")" \
    --expire 168h 2>/dev/null || true
}

send_report() {
  if [[ -z "${BACKUP_EMAIL_TO:-}" ]]; then
    log "email: BACKUP_EMAIL_TO не задан — пропускаю отчёт"
    return 0
  fi
  local subject body attach=()
  if [[ "${STATUS}" == "OK" ]]; then
    local db_link uploads_link config_link
    db_link="$(s3_link "${DB_FILE}")"
    uploads_link="$(s3_link "${UPLOADS_FILE}")"
    config_link="$(s3_link "${CONFIG_FILE}")"
    subject="✅ Outline backup OK — ${TS}"
    body="Бекап wiki.qwer.agency выполнен и проверен.

База данных:  $(basename "${DB_FILE}") ($(du -h "${DB_FILE}" 2>/dev/null | cut -f1))
${db_link:+  скачать (7 дней): ${db_link}}

Аплоады:      $(basename "${UPLOADS_FILE}" 2>/dev/null) ($(du -h "${UPLOADS_FILE}" 2>/dev/null | cut -f1))
${uploads_link:+  скачать (7 дней): ${uploads_link}}

Конфиги:      $(basename "${CONFIG_FILE}" 2>/dev/null) — содержит секреты, только по ссылке
${config_link:+  скачать (7 дней): ${config_link}}

Валидация:    дамп восстановлен во временную БД, таблиц: ${VERIFY_TABLES:-?}
S3:           ${S3_BUCKET:+s3://${S3_BUCKET}/${S3_PREFIX}/${S3_CLASS:-daily}/}${S3_BUCKET:-не настроен}
Ротация S3:   daily 30 дней, monthly 400 дней
Локально:     14 последних копий в /opt/outline/backups/"
    attach=("${DB_FILE}")
    [[ -f "${UPLOADS_FILE}" ]] && attach+=("${UPLOADS_FILE}")
  else
    subject="❌ Outline backup FAILED — ${TS}"
    body="Бекап wiki.qwer.agency ЗАВЕРШИЛСЯ С ОШИБКОЙ.

Причина: ${FAIL_REASON}

Смотри лог: /var/log/outline-backup.log на 92.53.99.158"
  fi
  python3 "${SRC_DIR}/backup-email.py" \
    --subject "${subject}" \
    --body "${body}" \
    --attach "${attach[@]}" \
    || log "! email-отчёт не отправился"
}

# ── 1. Дамп БД ───────────────────────────────────────────────────────────────
log "→ pg_dump → ${DB_FILE}"
docker compose exec -T postgres \
  pg_dump --clean --if-exists --no-owner -U outline outline \
  | gzip -9 > "${DB_FILE}"
log "✓ db: $(du -h "${DB_FILE}" | cut -f1)"

# ── 2. Валидация дампа ───────────────────────────────────────────────────────
log "→ валидация: gunzip -t"
gunzip -t "${DB_FILE}"

log "→ валидация: restore в outline_verify"
docker compose exec -T postgres psql -U outline -d postgres -q \
  -c "DROP DATABASE IF EXISTS outline_verify;" \
  -c "CREATE DATABASE outline_verify;"
gunzip -c "${DB_FILE}" \
  | docker compose exec -T postgres psql -U outline -d outline_verify -q \
      -v ON_ERROR_STOP=0 >/dev/null 2>&1 || true
VERIFY_TABLES="$(docker compose exec -T postgres psql -U outline -d outline_verify -tA \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
docker compose exec -T postgres psql -U outline -d postgres -q \
  -c "DROP DATABASE outline_verify;"
if [[ "${VERIFY_TABLES}" -lt 20 ]]; then
  log "✗ restore-проверка: таблиц ${VERIFY_TABLES} (< 20) — дамп подозрителен"
  false  # триггерим trap
fi
log "✓ restore-проверка: ${VERIFY_TABLES} таблиц"

# ── 3. Аплоады ───────────────────────────────────────────────────────────────
if [[ -d "${ROOT}/data" ]] && [[ -n "$(ls -A "${ROOT}/data" 2>/dev/null)" ]]; then
  log "→ tar uploads"
  tar -C "${ROOT}" -czf "${UPLOADS_FILE}" data/
  tar -tzf "${UPLOADS_FILE}" >/dev/null
  log "✓ uploads: $(du -h "${UPLOADS_FILE}" | cut -f1)"
else
  log "skip uploads: ${ROOT}/data пуст"
fi

# ── 4. Конфиги (секреты!) ────────────────────────────────────────────────────
log "→ tar config"
CONFIG_ITEMS=()
[[ -f "${ROOT}/.env" ]] && CONFIG_ITEMS+=("${ROOT}/.env")
[[ -f "${ROOT}/docker-compose.yml" ]] && CONFIG_ITEMS+=("${ROOT}/docker-compose.yml")
[[ -f /etc/nginx/sites-available/wiki.qwer.agency ]] && CONFIG_ITEMS+=(/etc/nginx/sites-available/wiki.qwer.agency)
[[ -f /etc/cron.d/outline-backup ]] && CONFIG_ITEMS+=(/etc/cron.d/outline-backup)
tar -czf "${CONFIG_FILE}" --absolute-names "${CONFIG_ITEMS[@]}" 2>/dev/null
tar -tzf "${CONFIG_FILE}" >/dev/null
chmod 600 "${CONFIG_FILE}"
log "✓ config: $(du -h "${CONFIG_FILE}" | cut -f1)"

# ── 5. S3 upload + ротация ───────────────────────────────────────────────────
if [[ -n "${S3_BUCKET}" ]] && command -v rclone >/dev/null 2>&1; then
  S3_CLASS="daily"
  [[ "${DOM}" == "01" ]] && S3_CLASS="monthly"
  DEST="${S3_REMOTE}:${S3_BUCKET}/${S3_PREFIX}/${S3_CLASS}"
  log "→ S3 upload → ${DEST}/"
  rclone copy "${DB_FILE}" "${DEST}/" --s3-no-check-bucket
  [[ -f "${UPLOADS_FILE}" ]] && rclone copy "${UPLOADS_FILE}" "${DEST}/" --s3-no-check-bucket
  rclone copy "${CONFIG_FILE}" "${DEST}/" --s3-no-check-bucket

  # Проверяем, что объекты реально в бакете
  log "→ S3 verify"
  rclone lsf "${DEST}/" | grep -qF "$(basename "${DB_FILE}")"
  log "✓ S3: $(basename "${DB_FILE}") подтверждён в бакете"

  log "→ S3 ротация (daily >30d, monthly >400d)"
  rclone delete "${S3_REMOTE}:${S3_BUCKET}/${S3_PREFIX}/daily/" --min-age 30d 2>/dev/null || true
  rclone delete "${S3_REMOTE}:${S3_BUCKET}/${S3_PREFIX}/monthly/" --min-age 400d 2>/dev/null || true
else
  log "skip S3: S3_BUCKET не задан или rclone не установлен"
fi

# ── 6. Локальная ротация: 14 последних ──────────────────────────────────────
log "→ локальная ротация (14 копий)"
ls -1t "${BACKUP_DIR}"/db-2*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -v
ls -1t "${BACKUP_DIR}"/uploads-2*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -v
ls -1t "${BACKUP_DIR}"/config-2*.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm -v

# ── 7. Email-отчёт ───────────────────────────────────────────────────────────
log "→ email-отчёт"
send_report

log "done."
