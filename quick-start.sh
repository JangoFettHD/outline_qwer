#!/usr/bin/env bash
#
# quick-start.sh — поднимает Outline локально на нестандартных портах.
#
# Backend (HTTP) : 13730
# Vite dev       : 13731
# Postgres       : 13732 -> 5432 (внутри контейнера)
# Redis          : 13733 -> 6379 (внутри контейнера)
#
# Состояние и бэкапы патченных файлов хранятся в ./.quick-start-state/.
# Остановить всё: ./stop-all.sh

set -euo pipefail

# -----------------------------------------------------------------------------
# Конфигурация портов (все выше 10000, не пересекаются с дефолтами Outline / VPN)
# -----------------------------------------------------------------------------
PORT_HTTP=13730
PORT_VITE=13731
PORT_PG=13732
PORT_REDIS=13733
URL="http://localhost:${PORT_HTTP}"
COMPOSE_PROJECT="outline-quick"
COMPOSE_FILE="docker-compose.quick.yml"

# -----------------------------------------------------------------------------
# Пути
# -----------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

STATE_DIR=".quick-start-state"
BACKUP_DIR="${STATE_DIR}/backups"
LOG_FILE="${STATE_DIR}/dev.log"
PID_FILE="${STATE_DIR}/dev.pid"
mkdir -p "${BACKUP_DIR}"

# -----------------------------------------------------------------------------
# Логирование
# -----------------------------------------------------------------------------
say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Проверка зависимостей и портов
# -----------------------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "не найден '$1' в PATH"; }
need docker
need node
need yarn
need openssl

if ! docker info >/dev/null 2>&1; then
  die "Docker не запущен — открой Docker Desktop и повтори."
fi

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
# Postgres/Redis-порты могут уже слушаться нашим же compose-проектом —
# `docker compose up -d` идемпотентен. Строго проверяем только HTTP/Vite,
# так как они нужны для dev:watch и должны быть полностью свободны.
for p in "${PORT_HTTP}" "${PORT_VITE}"; do
  if port_busy "$p"; then
    die "порт ${p} занят. Освободи его или поправь PORT_* в начале скрипта."
  fi
done
for p in "${PORT_PG}" "${PORT_REDIS}"; do
  if port_busy "$p"; then
    holder="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 {print $1}')"
    if [[ "${holder}" == com.docke* || "${holder}" == docker* || "${holder}" == vpnkit* ]]; then
      warn "порт ${p} уже держит docker (${holder}) — считаю что это наш compose, продолжаю"
    else
      die "порт ${p} занят процессом '${holder}' (не docker). Освободи его или поправь PORT_* в начале скрипта."
    fi
  fi
done

# -----------------------------------------------------------------------------
# Патчим хардкод порта 3001 у Vite в исходниках (с бэкапом)
# -----------------------------------------------------------------------------
patch_file() {
  local file="$1" backup="${BACKUP_DIR}/$(echo "$1" | sed 's|/|__|g').orig"
  if [[ ! -f "${backup}" ]]; then
    cp "${file}" "${backup}"
  else
    # Восстанавливаем оригинал, чтобы патч был идемпотентным.
    cp "${backup}" "${file}"
  fi
  # Заменяем все три формы хардкода:
  #   `port: 3001`     (vite.config.ts)
  #   `:3001`          (server/routes/app.ts, csp.ts)
  #   `localhost:3001` (csp.ts) — покрыто общим `:3001`, оставлено для явности
  sed -i.bak \
    -e "s#port: 3001#port: ${PORT_VITE}#g" \
    -e "s#:3001#:${PORT_VITE}#g" \
    "${file}"
  rm -f "${file}.bak"
}

say "Патчу порт Vite в исходниках (бэкапы в ${BACKUP_DIR}/)…"
patch_file "vite.config.ts"
patch_file "server/routes/app.ts"
patch_file "server/middlewares/csp.ts"
ok "Порт Vite в исходниках переключён на ${PORT_VITE}"

# -----------------------------------------------------------------------------
# Генерируем .env.local (если ещё нет)
# -----------------------------------------------------------------------------
ENV_LOCAL=".env.local"
if [[ ! -f "${ENV_LOCAL}" ]]; then
  say "Генерирую ${ENV_LOCAL}…"
  SECRET_KEY="$(openssl rand -hex 32)"
  UTILS_SECRET="$(openssl rand -hex 32)"
  cat > "${ENV_LOCAL}" <<EOF
# Создано quick-start.sh — не коммитить.
NODE_ENV=development

URL=${URL}
PORT=${PORT_HTTP}
FORCE_HTTPS=false

DATABASE_URL=postgres://user:pass@127.0.0.1:${PORT_PG}/outline
PGSSLMODE=disable
REDIS_URL=redis://127.0.0.1:${PORT_REDIS}

SECRET_KEY=${SECRET_KEY}
UTILS_SECRET=${UTILS_SECRET}

FILE_STORAGE=local
FILE_STORAGE_LOCAL_ROOT_DIR=${HERE}/data/uploads

SMTP_FROM_EMAIL=hello@example.com
DEVELOPMENT_UNSAFE_INLINE_CSP=true
LOG_LEVEL=debug
# Внимание: русская локаль (ru_RU) в Outline официально не поддерживается —
# отсутствует в shared/i18n. Список валидных значений видно в @shared/i18n.languages.
DEFAULT_LANGUAGE=en_US
RATE_LIMITER_ENABLED=false
EOF
  ok ".env.local создан с новыми SECRET_KEY/UTILS_SECRET"
else
  warn ".env.local уже существует — секреты/порты не перегенерирую."
fi

# Идемпотентно проставляем ключ=значение в .env.local
upsert_env() {
  local key="$1" value="$2" file="${ENV_LOCAL}"
  # Экранируем разделитель '#' (sed) — значения OAuth содержат только [A-Za-z0-9._-/:].
  if grep -qE "^${key}=" "${file}" 2>/dev/null; then
    sed -i.bak "s#^${key}=.*#${key}=${value}#" "${file}"
    rm -f "${file}.bak"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

# Если ключи Bitrix24 переданы через окружение — записываем их в .env.local.
if [[ -n "${BITRIX24_CLIENT_ID:-}" || -n "${BITRIX24_CLIENT_SECRET:-}" || -n "${BITRIX24_PORTAL_URL:-}" ]]; then
  say "Прописываю BITRIX24_* в ${ENV_LOCAL}…"
  [[ -n "${BITRIX24_CLIENT_ID:-}"     ]] && upsert_env BITRIX24_CLIENT_ID     "${BITRIX24_CLIENT_ID}"
  [[ -n "${BITRIX24_CLIENT_SECRET:-}" ]] && upsert_env BITRIX24_CLIENT_SECRET "${BITRIX24_CLIENT_SECRET}"
  [[ -n "${BITRIX24_PORTAL_URL:-}"    ]] && upsert_env BITRIX24_PORTAL_URL    "${BITRIX24_PORTAL_URL}"
  ok "BITRIX24_* записаны"
fi

# .sequelizerc принудительно грузит файл `.env` (без cascade, в отличие от
# server/utils/environment.ts). Без него sequelize-cli не увидит DATABASE_URL.
# Делаем симлинк, чтобы единственным источником правды оставался .env.local.
if [[ ! -e .env || -L .env ]]; then
  ln -sfn "${ENV_LOCAL}" .env
  ok ".env → ${ENV_LOCAL} (для sequelize-cli)"
elif [[ -f .env ]]; then
  warn ".env уже существует как обычный файл — не трогаю. Проверь, что в нём DATABASE_URL."
fi

mkdir -p "${HERE}/data/uploads"

# -----------------------------------------------------------------------------
# Поднимаем Postgres + Redis
# -----------------------------------------------------------------------------
say "Тяну образы Postgres/Redis (с ретраями — Docker Hub бывает капризен)…"
pulled=0
for attempt in 1 2 3; do
  if docker compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" pull --quiet; then
    pulled=1
    break
  fi
  warn "Попытка ${attempt} не удалась, жду 5 сек и повторяю…"
  sleep 5
done
if [[ "${pulled}" != "1" ]]; then
  cat >&2 <<'EOM'
✗ Не получилось скачать образы с Docker Hub.
  Скорее всего блокировка/деградация registry-1.docker.io.

  Что сделать:
  1) Включить VPN и повторить ./quick-start.sh
  2) Или прописать registry-mirror в Docker Desktop:
       Settings → Docker Engine → добавить в JSON:
         "registry-mirrors": [
           "https://mirror.gcr.io",
           "https://dockerhub.timeweb.cloud"
         ]
       → Apply & Restart, затем повторить ./quick-start.sh
EOM
  exit 1
fi

say "Поднимаю Postgres и Redis (проект docker compose '${COMPOSE_PROJECT}')…"
docker compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" up -d

say "Жду healthcheck Postgres…"
PG_CID="$(docker compose -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" ps -q postgres)"
for i in $(seq 1 60); do
  status="$(docker inspect -f '{{.State.Health.Status}}' "${PG_CID}" 2>/dev/null || echo starting)"
  if [[ "${status}" == "healthy" ]]; then
    ok "Postgres готов"
    break
  fi
  sleep 1
  if [[ "$i" == "60" ]]; then
    die "Postgres не дошёл до healthy за 60 сек (status=${status}). Логи: docker compose -p ${COMPOSE_PROJECT} -f ${COMPOSE_FILE} logs postgres"
  fi
done

# -----------------------------------------------------------------------------
# yarn install + миграции
# -----------------------------------------------------------------------------
if [[ ! -d node_modules ]]; then
  say "Ставлю зависимости (yarn install)…"
  yarn install --immutable
else
  ok "node_modules уже есть — пропускаю yarn install"
fi

# Некоторые data-миграции запускают node-скрипты из build/server/scripts/
# (см. 20230815063834-migrate-emoji-in-document-title), поэтому build обязателен
# ДО миграций. Также кеширует transpile для первого dev-старта.
if [[ ! -d build/server || ! -f "build/server/scripts/20230815063834-migrate-emoji-in-document-title.js" ]]; then
  say "Билжу сервер (yarn build:server) — нужно для миграций…"
  yarn build:server
else
  ok "build/server уже на месте — пропускаю build:server"
fi

say "Прогоняю миграции БД…"
NODE_ENV=development yarn db:migrate

# -----------------------------------------------------------------------------
# Стартуем dev режим (backend + vite) в фоне
# -----------------------------------------------------------------------------
if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  die "Похоже dev уже запущен (PID $(cat "${PID_FILE}")). Сначала ./stop-all.sh"
fi

say "Запускаю backend + Vite (логи: ${LOG_FILE})…"
# Включаем job control, чтобы backgrounded subshell получил свой process group.
set -m
( NODE_ENV=development yarn dev:watch >"${LOG_FILE}" 2>&1 ) &
DEV_PID=$!
set +m
echo "${DEV_PID}" > "${PID_FILE}"
ok "dev:watch стартовал, PID=${DEV_PID}"

# -----------------------------------------------------------------------------
# Готово
# -----------------------------------------------------------------------------
cat <<EOF

──────────────────────────────────────────────
  Outline поднимается.
  Backend:  ${URL}
  Vite dev: http://localhost:${PORT_VITE}
  Postgres: 127.0.0.1:${PORT_PG}  (user/pass/outline)
  Redis:    127.0.0.1:${PORT_REDIS}

  Первый билд сервера занимает ~30–60 сек. Следи за логом:
      tail -f ${LOG_FILE}

  Авторизация Bitrix24 включается переменными в .env.local:
      BITRIX24_CLIENT_ID=...
      BITRIX24_CLIENT_SECRET=...
      BITRIX24_PORTAL_URL=https://<portal>.bitrix24.ru
  Кнопка «Continue with Bitrix24» появится на странице логина.

  ⚠ В настройках локального приложения Bitrix24 «Путь обработчика»
    должен совпадать с URL Outline + /auth/bitrix24.callback,
    т.е. для quick-start:   ${URL}/auth/bitrix24.callback

  Остановить всё:  ./stop-all.sh
──────────────────────────────────────────────
EOF
