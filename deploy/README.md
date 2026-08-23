# Деплой портала ИД (id)

Портал разворачивается на общем production-VPS (`backend-vps-1`) рядом с estimat, billhub,
technic, zakupki, fin. Деплой **portal-scoped**: `deploy-id` работает только с проектом
`-p id` и не должен трогать соседей, `infra-nginx`, Keycloak.

Отступление от корпстандарта §19 (этап 1): образ собирается на VPS
(`git pull` + `docker compose build`), без Container Registry.

## Auth / Keycloak

В `NODE_ENV=production` код требует `AUTH_MODE=oidc` и тройку `OIDC_*`.
`AUTH_MODE=dev-stub` в production **запрещён** (fail-fast при старте).

Пока клиента Keycloak нет — **полноценный вход недоступен**, api/worker с боевым
`id.env` не поднимутся, пока не заполнены OIDC или не изменён код auth.
Сида админа как у fin (`SEED_ADMIN_*`) в этом портале нет: пользователи
появляются при первом OIDC-логине.

Каталог/rules/prompts сидятся SQL-миграциями (`deploy-id --migrate`).

## Архитектура на VPS

- Код: `/opt/portals/id`
- Секреты: `/etc/id/id.env`, `/etc/id/id-migrate.env` (640 root:docker), CA `/etc/id/root.crt`
- Ingress: `/opt/infra/nginx/conf.d/id.conf` (контейнер `infra-nginx`)
- Сеть: `edge` (external)
- Сервисы: `id-api`, `id-worker`, `id-web` (имена уникальны на хосте)
- Команда: `sudo ln -sf /opt/portals/id/deploy/deploy-id.sh /usr/local/bin/deploy-id`

Диск часто ~80%: перед первой сборкой `df -h /`. При нехватке —
`docker buildx prune` (точечно). **Не** `docker system prune -a`.

## 1. База данных

Кластер тот же, что у estimat/fin. БД: **`ID`**. Роль: **`fin_id`**.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
GRANT CONNECT ON DATABASE "ID" TO fin_id;
GRANT USAGE, CREATE ON SCHEMA public TO fin_id;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fin_id;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fin_id;
```

Без `ALTER DEFAULT PRIVILEGES` / `ALTER ROLE … CONNECTION LIMIT` (на Managed PG —
permission denied / не нужны при одной роли).

Пароль `fin_id` брать с хоста (`/etc/fin/.db_password` или fin.env), URL-encode в
`DATABASE_URL`. Не тащить в чат.

TLS: в URL можно оставить `sslmode=verify-full` — код вырезает `sslmode`/`sslrootcert`
и проверяет цепочку через `PG_CA_CERT_PATH` (как fin `pg-ssl.ts`).

## 2. Секреты на хосте

```bash
sudo mkdir -p /etc/id
sudo install -m 640 -o root -g docker deploy/id.env.example /etc/id/id.env
sudo install -m 640 -o root -g docker deploy/id-migrate.env.example /etc/id/id-migrate.env
sudo cp /etc/fin/root.crt /etc/id/root.crt   # тот же CA Yandex
sudo chmod 644 /etc/id/root.crt
```

Сгенерировать ключи на сервере:

```bash
openssl rand -base64 32   # SESSION_ENC_KEY (32 байта после decode)
openssl rand -base64 48   # CSRF_SECRET
openssl rand -base64 48   # AUDIT_HMAC_KEY
```

### S3

- Endpoint: `https://s3.cloud.ru` (как у соседних порталов)
- Bucket: `id1`
- Region: `ru-central-1`
- `S3_ACCESS_KEY` / `S3_SECRET_KEY` — только в `/etc/id/id.env`

Если секрет и tenant id пришли одной строкой в файле — в env кладётся **только
секрет** в `S3_SECRET_KEY` (tenant в приложении не используется). Не коммитить
и не печатать строку.

#### CORS на бакете — обязателен, иначе файлы не грузятся

Байты идут в хранилище **мимо портала**: сервер выдаёт presigned PUT, а браузер
шлёт `PUT` с телом прямо в S3. `PUT` не относится к «простым» методам, поэтому
браузер сначала делает preflight `OPTIONS`, и без CORS-политики бакета обрывает
обмен сам. Пользователь при этом видит отказ загрузки, в котором про CORS не
сказано ничего, — спецификация запрещает браузеру рассказывать скрипту причину.

Это внешнее требование к бакету, кодом портала не закрываемое. Настраивается
один раз:

```bash
cat > cors.json <<'JSON'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://id.su10.ru"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
JSON

aws --endpoint-url https://s3.cloud.ru s3api put-bucket-cors \
    --bucket id1 --cors-configuration file://cors.json
aws --endpoint-url https://s3.cloud.ru s3api get-bucket-cors --bucket id1
```

Проверка без браузера — preflight обязан вернуть `Access-Control-Allow-Origin`:

```bash
curl -i -X OPTIONS "<свежий presigned URL из ответа upload/init>" \
  -H "Origin: https://id.su10.ru" -H "Access-Control-Request-Method: PUT"
```

Чего в политике быть НЕ должно и почему:

- `AllowCredentials` — клиент шлёт `credentials: 'same-origin'` и cookie в чужой
  origin не отправляет;
- `GET`/`HEAD` — содержимое файлов портал отдаёт сам, через
  `GET /files/{id}/content` под сессией. Presigned GET в браузер не выдаётся
  принципиально (§4.2): он утекает в историю и живёт мимо RBAC до конца TTL.

`DB` host взять из `/etc/estimat/estimat.env` (`DB_HOST`, порт `6432`) без печати паролей.

`TRUST_PROXY=172.18.0.0/16` — подсеть `edge` (проверить `docker network inspect edge`).

### LLM (proxy_llm)

- `LLM_PROVIDER=proxy_llm`
- `PROXY_LLM_BASE_URL=https://proxyllm.fvds.ru/api/v1` (тот же шлюз, что у estimat)
- `LLM_MODEL=deepseek/deepseek-v4-flash-0731`
- `LLM_MODEL_ALLOWLIST=deepseek/deepseek-v4-flash-0731` (в production пустой allowlist запрещает всё)
- `PROXY_LLM_TOKEN` — только в `/etc/id/id.env`, не в git/чат

**Модель распознавания входит в тот же allowlist.** `recognition.vlm_model`
выбирается в «Администрирование → Настройки», но запуск прогона сверяется с
`LLM_MODEL_ALLOWLIST` и отвечает 409 **до** создания прогона. Слаг, выбранный в
настройках, обязан быть в списке — перечисляются через запятую:

```
LLM_MODEL_ALLOWLIST=deepseek/deepseek-v4-flash-0731,google/gemini-3.7-flash
```

Отдельно убедиться, что шлюз `proxyllm.fvds.ru` эту модель пропускает: его
собственный список моделей портал не видит и проверить не может.

RD WEB (`RDWEB_*`) на первом подъёме не обязателен.

Миграции: `deploy-id --migrate` (или `compose … run --rm migrate`) — по желанию оператора.

## 3. Код и симлинк

```bash
sudo git clone https://github.com/saztonov/id /opt/portals/id
sudo chown -R corpsu:corpsu /opt/portals/id
sudo ln -sf /opt/portals/id/deploy/deploy-id.sh /usr/local/bin/deploy-id
```

## 4. TLS (до vhost портала)

ACME webroot уже в `00-default.conf`:

```bash
docker exec infra-certbot certbot certonly --webroot -w /var/www/certbot \
  -d id.su10.ru --non-interactive --agree-tos \
  --register-unsafely-without-email --keep-until-expiring
```

## 5. Nginx

```bash
ID_DOMAIN=id.su10.ru envsubst '$ID_DOMAIN' \
  < /opt/portals/id/deploy/nginx/id.conf.template \
  | sudo tee /opt/infra/nginx/conf.d/id.conf
grep server_name /opt/infra/nginx/conf.d/id.conf   # без ${…}
docker exec infra-nginx nginx -t && docker exec infra-nginx nginx -s reload
```

## 6. Деплой

После заполнения OIDC (или отдельного патча auth):

```bash
deploy-id --migrate
```

Обновление: `deploy-id` / `deploy-id --migrate`.
Откат: `git -C /opt/portals/id checkout <SHA> && deploy-id` (без down-миграций).

## 7. Smoke

- `https://id.su10.ru` → 200 (статика)
- изнутри: `docker compose -p id exec id-api wget -qO- http://127.0.0.1:3000/health/ready`
- API prefix: `/api/v1/…`; auth: `/auth/…`, `/me`

## Запреты

- Не править исходники на VPS — только локальный репо → commit → push → pull/deploy
- Не `docker system prune -a`, не `compose down --volumes` у соседей
- Не печатать `DATABASE_URL` / ключи / OIDC secret в отчётах
