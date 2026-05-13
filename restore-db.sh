#!/usr/bin/env bash
#
# restore-db.sh — восстанавливает Postgres из дампа, сделанного backup-db.sh.
#
# Использование:
#   ./restore-db.sh /opt/outline/backups/db-2026-05-13-040000.sql.gz
#
# ВНИМАНИЕ: восстановление СНОСИТ текущую БД (pg_dump --clean), все локальные
# изменения после момента бэкапа будут потеряны.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <db-XXXX.sql.gz>" >&2
  exit 2
fi

DUMP="$1"
if [[ ! -f "${DUMP}" ]]; then
  echo "✗ Файл не найден: ${DUMP}" >&2
  exit 1
fi

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

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }

warn "Сейчас восстановим БД из ${DUMP}."
warn "Текущие данные в БД БУДУТ ЗАМЕНЕНЫ."
read -r -p "Введите RESTORE для подтверждения: " confirm
if [[ "${confirm}" != "RESTORE" ]]; then
  echo "Отменено."
  exit 1
fi

# Останавливаем outline, чтобы он не писал в БД во время восстановления.
say "Останавливаю outline (postgres продолжает работать)…"
docker compose stop outline

# Распаковываем и пайпим в psql внутри контейнера postgres.
say "Восстанавливаю дамп через psql…"
gunzip -c "${DUMP}" | docker compose exec -T postgres psql -U outline -d outline -v ON_ERROR_STOP=1

ok "Дамп применён."

# Подымаем обратно. outline-migrate отработает заново на свежевосстановленной
# БД — лишних миграций не накатит, всё уже есть.
say "Поднимаю outline обратно…"
docker compose up -d outline

ok "Готово. Проверь: docker logs outline-outline-1 -f"
