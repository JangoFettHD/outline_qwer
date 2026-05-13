#!/usr/bin/env bash
#
# stop-all.sh — останавливает то, что поднял ./quick-start.sh:
#   - dev процессы (yarn dev:watch + concurrently + nodemon + vite + node)
#   - контейнеры postgres/redis (docker compose проект outline-quick)
#   - возвращает на место исходники, которые патчил quick-start
#
# Данные (volumes postgres_data, redis_data) и .env.local НЕ удаляются.

set -uo pipefail

COMPOSE_PROJECT="outline-quick"
COMPOSE_FILE="docker-compose.quick.yml"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

STATE_DIR=".quick-start-state"
BACKUP_DIR="${STATE_DIR}/backups"
PID_FILE="${STATE_DIR}/dev.pid"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

# -----------------------------------------------------------------------------
# 1. Останавливаем dev процессы
# -----------------------------------------------------------------------------
# Рекурсивно собираем все pid поддерева.
collect_tree() {
  local pid="$1"
  printf '%s\n' "${pid}"
  local kid
  for kid in $(pgrep -P "${pid}" 2>/dev/null || true); do
    collect_tree "${kid}"
  done
}

if [[ -f "${PID_FILE}" ]]; then
  PID="$(cat "${PID_FILE}")"
  if kill -0 "${PID}" 2>/dev/null; then
    say "Убиваю дерево процессов ${PID}…"
    pids=$(collect_tree "${PID}")
    # SIGTERM сверху вниз
    while IFS= read -r p; do kill -TERM "${p}" 2>/dev/null || true; done <<<"${pids}"
    sleep 2
    # Контрольный SIGKILL по тем же pid (если кто остался)
    while IFS= read -r p; do kill -KILL "${p}" 2>/dev/null || true; done <<<"${pids}"
    # Плюс по PGID (на случай если pgrep что-то упустил)
    kill -TERM -- "-${PID}" 2>/dev/null || true
    kill -KILL -- "-${PID}" 2>/dev/null || true
    ok "dev процессы остановлены"
  else
    warn "PID ${PID} уже не активен"
  fi
  rm -f "${PID_FILE}"
fi

# Подчищаем потенциальных потомков, которые могли пережить kill группы.
for pat in \
  "yarn dev:watch" \
  "node.*build/server/index.js" \
  "node.*nodemon.*--watch server" \
  "concurrently.*backend,frontend" \
  "vite\\b"; do
  if pgrep -f "${pat}" >/dev/null 2>&1; then
    pkill -TERM -f "${pat}" 2>/dev/null || true
  fi
done
sleep 1
for pat in \
  "yarn dev:watch" \
  "node.*build/server/index.js" \
  "node.*nodemon.*--watch server" \
  "concurrently.*backend,frontend" \
  "vite\\b"; do
  pkill -KILL -f "${pat}" 2>/dev/null || true
done

# -----------------------------------------------------------------------------
# 2. Останавливаем контейнеры
# -----------------------------------------------------------------------------
if docker info >/dev/null 2>&1; then
  say "Останавливаю docker compose проект '${COMPOSE_PROJECT}'…"
  docker compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" down --remove-orphans
  ok "Контейнеры остановлены (данные сохранены в named volumes)"
else
  warn "Docker не запущен — пропускаю остановку контейнеров"
fi

# -----------------------------------------------------------------------------
# 3. Восстанавливаем исходники, которые патчил quick-start
# -----------------------------------------------------------------------------
restore_file() {
  local file="$1" backup="${BACKUP_DIR}/$(echo "$1" | sed 's|/|__|g').orig"
  if [[ -f "${backup}" ]]; then
    cp "${backup}" "${file}"
    rm -f "${backup}"
    ok "восстановлен: ${file}"
  fi
}

say "Восстанавливаю исходники из ${BACKUP_DIR}/…"
restore_file "vite.config.ts"
restore_file "server/routes/app.ts"
restore_file "server/middlewares/csp.ts"

# Подчищаем пустую папку бэкапов.
rmdir "${BACKUP_DIR}" 2>/dev/null || true

# Снимаем симлинк .env → .env.local (если есть).
if [[ -L .env ]]; then
  rm -f .env
  ok "снят симлинк .env"
fi

cat <<EOF

──────────────────────────────────────────────
  Outline остановлен.
  Сохранено: .env.local, named volumes (postgres_data, redis_data).
  Полностью обнулить базу:
      docker volume rm ${COMPOSE_PROJECT}_postgres_data ${COMPOSE_PROJECT}_redis_data
──────────────────────────────────────────────
EOF
