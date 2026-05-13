#!/usr/bin/env bash
#
# docker-stop.sh — останавливает прод-стек.
#
# По умолчанию: останавливает контейнеры, данные в volumes остаются.
# С флагом --volumes (-v): УДАЛЯЕТ named volumes (БД будет потеряна!).
#
# Использование:
#   ./docker-stop.sh              # обычная остановка
#   ./docker-stop.sh --volumes    # снести и БД (требует подтверждения)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${HERE}/docker-compose.yml" ]]; then
  ROOT="${HERE}"
elif [[ -f "${HERE}/../docker-compose.yml" ]]; then
  ROOT="$(cd "${HERE}/.." && pwd)"
else
  echo "✗ Не нашёл docker-compose.yml ни в ${HERE}, ни уровнем выше." >&2
  exit 1
fi
cd "${ROOT}"

say()  { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

WIPE_VOLUMES=0
if [[ "${1:-}" == "--volumes" || "${1:-}" == "-v" ]]; then
  WIPE_VOLUMES=1
fi

if [[ "${WIPE_VOLUMES}" == "1" ]]; then
  warn "ВНИМАНИЕ: с --volumes named volumes (БД, redis) будут УДАЛЕНЫ."
  warn "Это необратимо. Все документы Outline и аккаунты будут потеряны."
  read -r -p "Введите DELETE для подтверждения: " confirm
  if [[ "${confirm}" != "DELETE" ]]; then
    echo "Отменено."
    exit 1
  fi
  say "Останавливаю стек и удаляю volumes…"
  docker compose down -v --remove-orphans
  ok "Контейнеры и данные удалены."
else
  say "Останавливаю стек (volumes сохранены)…"
  docker compose down --remove-orphans
  ok "Контейнеры остановлены. Данные в volumes остались."
  echo "  Чтобы поднять обратно:    ./docker-start.sh"
  echo "  Чтобы снести и БД тоже:   ./docker-stop.sh --volumes"
fi
