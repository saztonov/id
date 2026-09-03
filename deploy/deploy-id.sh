#!/usr/bin/env bash
# Деплой портала ИД (id) — запускать НА VPS. Portal-scoped:
# не трогает соседние порталы, infra-nginx, Keycloak. Подключается симлинком:
#   sudo ln -sf /opt/portals/id/deploy/deploy-id.sh /usr/local/bin/deploy-id
#
#   deploy-id             — git pull + сборка образов + перезапуск api/worker/web
#   deploy-id --migrate   — то же + накат SQL-миграций
#
# Конфиг: /etc/id/id.env, /etc/id/id-migrate.env (640 root:docker).
# Секреты нигде не печатаются этим скриптом.
set -euo pipefail

ENV_FILE=/etc/id/id.env
MIGRATE_ENV_FILE=/etc/id/id-migrate.env
SCRIPT="$(readlink -f "$0")"
PORTAL_DIR="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
COMPOSE=(docker compose -f "$PORTAL_DIR/deploy/docker-compose.prod.yml" -p id)

usage() {
  cat <<'USAGE'
Использование: deploy-id [--migrate]
  --migrate   применить новые SQL-миграции (нужен /etc/id/id-migrate.env)
  -h, --help  эта справка
USAGE
}

MIGRATE=0
for arg in "$@"; do
  case "$arg" in
    --migrate) MIGRATE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

[ -r "$ENV_FILE" ] || { echo "Нет доступа к $ENV_FILE (права 640 root:docker; см. deploy/README.md)" >&2; exit 1; }

echo "==> [1/8] git pull ($PORTAL_DIR)"
if git -C "$PORTAL_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git -C "$PORTAL_DIR" pull --ff-only
else
  echo "git upstream не настроен — пропускаю pull"
fi

if ! git -C "$PORTAL_DIR" diff --quiet || ! git -C "$PORTAL_DIR" diff --cached --quiet; then
  echo "В рабочем каталоге есть незакоммиченные правки — деплой из неопределённого состояния запрещён" >&2
  exit 1
fi
ID_TAG="$(git -C "$PORTAL_DIR" rev-parse --short HEAD)"
export ID_TAG

# Метка выкатки для фронта — тот же короткий SHA, что и тег образа. Уходит
# build-аргументом в сборку id-web: по ней вкладка, открытая до выкатки,
# узнаёт, что работает на устаревшем бандле, и предлагает перезагрузиться.
# Тот же идентификатор попадает в отчёты об ошибках браузера — два разных
# значения одной выкатки не дали бы сопоставить их с серверным рядом по
# релизам. Проверка выше гарантирует, что SHA описывает содержимое сборки.
APP_RELEASE="${APP_RELEASE:-$ID_TAG}"
export APP_RELEASE

echo "==> [2/8] сверка ключей $ENV_FILE с примером"
# /etc/id/id.env ставится один раз копией примера (deploy/README.md) и дальше
# живёт своей жизнью: спринт добавляет ключ в пример, до сервера он не доезжает,
# и код молча работает на умолчаниях. Так пропала вся порция S41 — сторож памяти
# воркера был выключен на проде, а видно это было только по строке worker_ready.
#
# Сверяются ИМЕНА ключей, значения не читаются и не печатаются: этот скрипт
# секретов не показывает. Сверка идёт после pull — пример берётся уже новый.
#
# Не фатально: у большинства ключей есть умолчания, и валить выкатку из-за
# нового необязательного ключа хуже, чем выпустить её с предупреждением.
missing_keys="$(comm -23 \
  <(grep -oE '^[A-Z][A-Z0-9_]*=' "$PORTAL_DIR/deploy/id.env.example" | tr -d '=' | sort -u) \
  <(grep -oE '^[A-Z][A-Z0-9_]*=' "$ENV_FILE" | tr -d '=' | sort -u) \
  | tr '\n' ' ' | sed 's/ *$//')"
if [ -n "$missing_keys" ]; then
  echo "  В $ENV_FILE нет ключей из примера: $missing_keys" >&2
  echo "  Значения и комментарии к ним — deploy/id.env.example" >&2
else
  echo "  все ключи примера на месте"
fi

echo "==> [3/8] build (тег $ID_TAG)"
# Образы собираются ПО ОЧЕРЕДИ, а не одной командой `compose build`.
#
# Одна команда отдаёт сборку buildx bake, и тот запускает обе цели параллельно.
# На VPS с 8 ГБ, где уже работают два десятка контейнеров, два одновременных
# `pnpm install` (каждый со своим node_modules монорепо) съедали память до
# устойчивого memory pressure: BuildKit падал с «only one connection allowed»,
# journald двенадцать раз сбрасывал кэши, а SSH и HTTPS переставали отвечать —
# машину пришлось перезагружать, оставив деплой на половине.
#
# `COMPOSE_PARALLEL_LIMIT` здесь не помогает: он ограничивает собственную
# многопоточность Compose (up, pull, stop), а сборкой в этой версии управляет
# bake, для которого эта переменная ничего не значит. Раздельные вызовы —
# единственный способ, не зависящий от того, какую ручку уважает конкретная
# версия Compose.
#
# Собираются только службы с секцией `build`: id-worker и migrate делят образ
# с id-api и собственной сборки не имеют.
for service in id-api id-web; do
  echo "    -> $service"
  "${COMPOSE[@]}" build "$service"
done

MIGRATE_STATUS="нет"
if [ "$MIGRATE" = 1 ]; then
  echo "==> [4/8] migrate"
  # Воркер останавливается ДО наката. Миграции переименовывают таблицы (0028:
  # submissions -> works), и работающий воркер старого образа продолжал бы
  # обращаться к именам, которых уже нет: задачи падали бы, а следы этого
  # выглядели бы отказом конвейера, а не выкладкой. API останавливать не нужно —
  # его образ поднимается заново шагом ниже и до этого отвечает читателям.
  "${COMPOSE[@]}" stop id-worker >/dev/null 2>&1 || true
  [ -r "$MIGRATE_ENV_FILE" ] || { echo "Нет доступа к $MIGRATE_ENV_FILE — см. deploy/README.md" >&2; exit 1; }
  MIGRATE_DATABASE_URL="$(grep -E '^MIGRATE_DATABASE_URL=' "$MIGRATE_ENV_FILE" | head -n1 | cut -d= -f2-)"
  [ -n "$MIGRATE_DATABASE_URL" ] || { echo "MIGRATE_DATABASE_URL не задан в $MIGRATE_ENV_FILE" >&2; exit 1; }
  export MIGRATE_DATABASE_URL
  "${COMPOSE[@]}" run --rm migrate
  unset MIGRATE_DATABASE_URL
  MIGRATE_STATUS="да"
else
  echo "==> [4/8] migrate пропущен (флаг --migrate не передан)"
fi

echo "==> [5/8] up"
"${COMPOSE[@]}" up -d id-api id-worker id-web

echo "==> [6/8] health (изнутри контейнера — публичный домен не требуется)"
health_ok=""
for _ in $(seq 1 40); do
  if "${COMPOSE[@]}" exec -T id-api wget -qO- http://127.0.0.1:3000/health/ready >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep 2
done

echo "==> [7/8] смоук маршрутов API"
# /health/ready живёт независимо от бизнес-маршрутов: выкатка с полностью
# выпиленным /api/v1 отчиталась бы «health: ok». Так и вышло в S44 —
# переименование маршрутов дошло до прода, и портал молча отвечал 404 на
# каждый список комплектов.
#
# Проверяется НАЛИЧИЕ маршрута, а не доступ: без сессии живой адрес отвечает
# 401, и это правильный ответ. Плохой ответ ровно один — 404.
ROUTES_OK=""
if [ -n "$health_ok" ]; then
  ROUTES_OK=1
  for route in /api/v1/folders /api/v1/catalog/objects /api/v1/admin/jobs; do
    headers="$("${COMPOSE[@]}" exec -T id-api wget -qS --spider --tries=1 \
      --timeout=5 "http://127.0.0.1:3000$route" 2>&1 || true)"
    code="$(echo "$headers" | awk '/HTTP\// { print $2; exit }')"
    if [ "$code" = "404" ] || [ -z "$code" ]; then
      echo "  МАРШРУТ НЕ ОТВЕЧАЕТ: $route (код ${code:-нет ответа})" >&2
      ROUTES_OK=""
    else
      echo "  $route → $code"
    fi
  done
fi

echo "==> [8/8] отчёт"
# Здоровье воркера отдельной строкой, а не только колонкой в таблице ниже:
# `unhealthy` у службы без публичных портов теряется среди прочих статусов, и
# именно так он и терялся — воркер месяцами считал задачи с красной пометкой.
worker_cid="$("${COMPOSE[@]}" ps -q id-worker 2>/dev/null || true)"
if [ -n "$worker_cid" ]; then
  worker_health="$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}проверки нет{{end}}' \
    "$worker_cid" 2>/dev/null || echo 'не удалось спросить')"
else
  worker_health="контейнера нет"
fi
echo
echo "===== ОТЧЁТ О ДЕПЛОЕ (id) ====="
echo "время:    $(date -Is)"
echo "коммит:   $(git -C "$PORTAL_DIR" rev-parse HEAD) (тег образа $ID_TAG)"
echo "миграции: $MIGRATE_STATUS"
echo "health:   $([ -n "$health_ok" ] && echo ok || echo 'НЕ готов — docker compose -p id logs id-api')"
echo "маршруты: $([ -n "$ROUTES_OK" ] && echo ok || echo 'НЕ отвечают — портал поднялся, но /api/v1 недоступен')"
echo "воркер:   $worker_health (служебный /metrics; starting сразу после выкатки — норма)"
echo "env-ключи: ${missing_keys:-ok}${missing_keys:+ — нет в $ENV_FILE, см. deploy/id.env.example}"
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
echo "================================"

[ -n "$health_ok" ] || exit 1
[ -n "$ROUTES_OK" ] || exit 1
echo "Готово."
