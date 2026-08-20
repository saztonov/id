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

`DB` host взять из `/etc/estimat/estimat.env` (`DB_HOST`, порт `6432`) без печати паролей.

`TRUST_PROXY=172.18.0.0/16` — подсеть `edge` (проверить `docker network inspect edge`).

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
