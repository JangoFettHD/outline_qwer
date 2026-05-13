#!/usr/bin/env bash
#
# docker-start.sh — пересобирает образ и поднимает прод-стек.
#
# Workflow:
#   cd /opt/outline/src
#   git pull        # или rsync с локалки
#   ./docker-start.sh
#
# Скрипт автоматически находит docker-compose.yml: ищет рядом с собой,
# а если лежит внутри src/ — поднимается на уровень выше.

set -euo pipefail

# -----------------------------------------------------------------------------
# Где лежит docker-compose.yml (root проекта на сервере)
# -----------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${HERE}/docker-compose.yml" ]]; then
  ROOT="${HERE}"
  SRC_DIR="${HERE}/src"
elif [[ -f "${HERE}/../docker-compose.yml" ]]; then
  ROOT="$(cd "${HERE}/.." && pwd)"
  SRC_DIR="${HERE}"
else
  echo "✗ Не нашёл docker-compose.yml ни в ${HERE}, ни уровнем выше." >&2
  exit 1
fi
cd "${ROOT}"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Sanity-check
# -----------------------------------------------------------------------------
[[ -f "${ROOT}/.env" ]] || die ".env не найден в ${ROOT}/. Создай его (см. .env.production.example в репо)."
[[ -d "${SRC_DIR}" ]] || die "Каталог исходников ${SRC_DIR} не найден."
[[ -f "${SRC_DIR}/Dockerfile.base" ]] || die "${SRC_DIR}/Dockerfile.base не найден."

if ! docker info >/dev/null 2>&1; then
  die "Docker не запущен."
fi

# -----------------------------------------------------------------------------
# 1. Сборка base (deps + yarn build) — Docker layer cache переживёт «ничего не
#    изменилось» за ~5 секунд; полная пересборка ~5 минут.
# -----------------------------------------------------------------------------
say "Билжу outline-qwer-base (yarn install + yarn build)…"
docker build \
  -t outline-qwer-base:latest \
  -f "${SRC_DIR}/Dockerfile.base" \
  "${SRC_DIR}"
ok "outline-qwer-base готов"

# -----------------------------------------------------------------------------
# 2. Сборка финального slim-образа из base
# -----------------------------------------------------------------------------
say "Билжу outline-qwer (runtime образ)…"
docker build \
  -t outline-qwer:latest \
  --build-arg BASE_IMAGE=outline-qwer-base:latest \
  -f "${SRC_DIR}/Dockerfile" \
  "${SRC_DIR}"
ok "outline-qwer готов"

# -----------------------------------------------------------------------------
# 3. Поднимаем стек. compose сам прогонит outline-migrate перед outline.
# -----------------------------------------------------------------------------
say "Останавливаю старый outline (volume не трогаю — данные остаются)…"
docker compose stop outline outline-migrate 2>/dev/null || true
docker compose rm -f outline outline-migrate 2>/dev/null || true

say "Поднимаю стек…"
docker compose up -d

say "Жду пока outline станет healthy…"
deadline=$(( $(date +%s) + 180 ))
until [[ "$(docker inspect -f '{{.State.Health.Status}}' outline-outline-1 2>/dev/null || echo none)" == "healthy" ]]; do
  if [[ $(date +%s) -gt ${deadline} ]]; then
    warn "outline не дошёл до healthy за 3 минуты — проверь логи: docker logs outline-outline-1 --tail 100"
    exit 1
  fi
  sleep 3
done

URL="$(grep -E '^URL=' "${ROOT}/.env" | head -1 | cut -d= -f2-)"
ok "Outline здоров. Открывай: ${URL}"

cat <<EOF

──────────────────────────────────────────────
  Логи:        docker logs outline-outline-1 -f --tail 100
  Миграции:    docker logs outline-outline-migrate-1 --tail 50
  Бэкап БД:    ./backup-db.sh
  Остановить:  ./docker-stop.sh
──────────────────────────────────────────────
EOF
