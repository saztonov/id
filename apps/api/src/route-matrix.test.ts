/**
 * Гейт «матрица роль × ручка»: каждая ручка API проверена на КАЖДОЙ роли.
 *
 * ## Зачем этот файл появился
 *
 * Свипы «все ручки модуля» в портале были — у администрирования (`ADMIN_PROBES`
 * в `modules/admin/admin.test.ts`) и у справочника. Оба ведутся РУКАМИ, и у
 * обоих одно слабое место: новый эндпоинт, не дописанный в список, в свип не
 * попадает молча. Список из ста семидесяти строк, который правит человек, — это
 * проверка человеческой памяти, а не проверка прав.
 *
 * Здесь перечень ручек выводится из САМОГО РОУТЕРА: приложение поднимается с
 * наблюдателем `onRoute` (`BuildAppOptions.onRoute`), и в матрицу попадает ровно
 * то, что зарегистрировано. Новая ручка, не описанная в реестре ниже, красит
 * гейт — и это единственный способ, которым проверка остаётся полной.
 *
 * ## Три утверждения, а не одно
 *
 * 1. **Роутер и реестр описывают один набор маршрутов** — расхождение красное в
 *    обе стороны: и новая ручка без записи, и запись без ручки.
 * 2. **Объявленное право совпадает с правом на маршруте.** Это НЕ дублирование
 *    поведенческой пробы, а то, чего она не умеет: `document.edit`,
 *    `checks.run`, `registry.accept`, `folder.approve` и `folder.return` выданы
 *    ОДНОМУ набору ролей `[engineer, manager]`, поэтому маршрут, закрытый по
 *    ошибке не тем правом, ведёт себя неотличимо от исправного. Отметку читает
 *    `routePermissions()` — она живёт в production рядом с писателем, потому что
 *    копия читателя в тесте, разъехавшаяся с писателем, вернула бы `null` на
 *    каждом маршруте и сделала бы гейт зелёным вхолостую.
 * 3. **Матрица.** Без сессии — 401; роль без права — 403; роль с правом — не 403.
 *
 * Рядом лежит дословная копия `PERMISSIONS`: иначе расширение права (кто-то
 * дописал `contractor` в `folder.approve`) дало бы зелёный гейт, послушно
 * проверяющий, что подрядчику теперь можно.
 *
 * ## Почему приложений два
 *
 * Часть маршрутов регистрируется по настройке: вход паролем и админка локальных
 * учётных записей живут только при `AUTH_MODE=local`. Поднимаются оба приложения
 * на одном пуле (приём из `navigation/client-routes.test.ts`), а поле `modes` в
 * реестре ловит и обратный дефект — «маршрут исчез в одном из режимов». Сессия,
 * полученная в `dev-stub`, годится и для второго приложения: cookie подписана
 * `CSRF_SECRET`, а он у обоих один, и строка сессии лежит в общем пуле.
 *
 * ## Почему анонимная проба обязана давать РОВНО 401
 *
 * Она — канарейка годности пробы. Валидация схемы в Fastify идёт РАНЬШЕ
 * `preHandler`, поэтому негодное тело даёт 422 всем трём пробам сразу, и матрица
 * проверила бы не право, а собственную опечатку. При ожидании 401 негодная проба
 * краснеет на самой дешёвой из проверок и с понятным сообщением. Молча зелёной
 * она стать не может.
 *
 * Это же закрывает права, выданные всем пяти ролям (`submission.*`,
 * `pipeline.run`, `markup.read`, `archive.download`): у них нет ни одной отказной
 * роли, и годность пробы доказывать больше нечем.
 *
 * ## Почему 400/409/422/500 годятся для положительной пробы, а 404 — нет
 *
 * Право проверяется в `preHandler`, ДО обработчика. Значит любой ответ
 * обработчика уже доказывает, что гейт пропустил: цель пробы — «право не
 * заперло», а не «ручка работает». Но `404` с телом `Маршрут не найден.`
 * (дословно из `app.setNotFoundHandler`) означает обратное — запрос не дошёл до
 * маршрута вовсе, подстановка параметра промахнулась, и все три пробы ничего не
 * проверили. Различаются они не статусом, а телом — тем же приёмом, что в
 * `navigation/client-routes.test.ts`.
 *
 * ## Чего этот гейт НЕ доказывает
 *
 * - **Область видимости** — второй уровень изоляции (§4.1). Что инженер не
 *   увидит чужую поставку, а подрядчик — чужой файл, проверяет
 *   `auth/isolation.test.ts` и модульные тесты навигации.
 * - **Правильность самой матрицы прав и самого реестра.** Гейт ловит
 *   РАСХОЖДЕНИЕ, а не заблуждение: ошибка в реестре, совпавшая с ошибкой на
 *   маршруте, даёт зелёный тест.
 * - **Модуль, написанный и не подключённый в `app.ts`.** Обе стороны сравнения
 *   окажутся пусты. Это ловит `navigation/client-routes.test.ts`.
 * - **Проверки прав внутри обработчиков** (`requireManagedByActor`, блокеры
 *   согласования, `enforceImmutability`) — только гейт на маршруте.
 * - **Конфигурации `AUTH_MODE=oidc` и `STORAGE_DRIVER=s3`.**
 * - **Работоспособность ручки.** «Не 403» — это и 500 из-за отсутствующего S3.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { UserRole } from '@id/contracts';
import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';

import { buildApp, type AppInstance, type ObservedRoute } from './app.js';
import { loadEnv } from './config/env.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from './auth/session.js';
import { hashPassword } from './auth/local/passwords.js';
import { PERMISSIONS, routePermissions, type Permission } from './middleware/require-permission.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-route-matrix-'));

/** Дословно из `app.setNotFoundHandler` и `middleware/*`. */
const ROUTE_MISSING = 'Маршрут не найден.';
const NEEDS_LOGIN = 'Требуется вход в портал.';
const NOT_PERMITTED = 'Недостаточно прав для этого действия.';

type Mode = 'sso' | 'local';

type Access = Permission | readonly Permission[] | 'authenticated' | 'public';

interface Expectation {
  readonly access: Access;
  /** В какой конфигурации маршрут существует. По умолчанию — в обеих. */
  readonly modes?: readonly Mode[];
  /** Замена автоподстановке параметра пути. */
  readonly params?: Readonly<Record<string, string>>;
  /** Замена автоподстановке строки запроса (формат, который zod собирает `transform`). */
  readonly query?: Readonly<Record<string, string>>;
  /** Тело, если из zod-схемы его собрать нельзя (refine, контрольные суммы). */
  readonly body?: unknown;
  /** Почему положительная проба не выполняется. Только с доводом. */
  readonly noPositiveProbe?: string;
}

/**
 * Ключ — дословно то, что даёт роутер (`МЕТОД шаблон`), чтобы строку из падения
 * можно было скопировать в поиск. Значение типизовано литералами `Permission`,
 * поэтому опечатка в названии права — ошибка компиляции, а не зелёный тест.
 */
const EXPECTED: Readonly<Record<string, Access | Expectation>> = {
  'DELETE /api/v1/admin/settings/:key': 'settings.manage',
  'DELETE /api/v1/catalog/counterparties/:counterpartyId': 'settings.manage',
  'DELETE /api/v1/catalog/doc-types/:code/override': 'doc_types.manage',
  'DELETE /api/v1/catalog/objects/:objectId': 'settings.manage',
  'DELETE /api/v1/documents/:documentId/confirm': 'document.edit',
  'DELETE /api/v1/folders/:folderId': 'submission.delete',
  'DELETE /api/v1/folders/:folderId/files/:fileId': 'submission.upload',
  'DELETE /api/v1/folders/:folderId/pages/:sourcePageId/manual-label': 'document.edit',
  'DELETE /api/v1/folders/:folderId/pages/:sourcePageId/orientation': 'markup.edit',
  'DELETE /api/v1/layouts/:layoutId/blocks/:blockId': 'markup.edit',
  'GET /api/v1/admin/errors': 'diagnostics.read',
  'GET /api/v1/admin/errors/:issueId': 'diagnostics.read',
  'GET /api/v1/admin/errors/:issueId/series': 'diagnostics.read',
  'GET /api/v1/admin/errors/samples': 'diagnostics.read',
  'GET /api/v1/admin/errors/summary': 'diagnostics.read',
  'GET /api/v1/admin/http-anomalies': 'diagnostics.read',
  'GET /api/v1/admin/jobs': 'diagnostics.read',
  'GET /api/v1/admin/jobs/:jobId': 'diagnostics.read',
  'GET /api/v1/admin/jobs/queues': 'diagnostics.read',
  'GET /api/v1/admin/pipeline-feedback/events': 'diagnostics.read',
  'GET /api/v1/admin/pipeline-feedback/export': 'diagnostics.read',
  'GET /api/v1/admin/pipeline-feedback/summary': 'diagnostics.read',
  'GET /api/v1/admin/prompts': 'settings.manage',
  'GET /api/v1/admin/prompts/:id': 'settings.manage',
  'GET /api/v1/admin/registration-requests': { access: 'users.manage', modes: ['local'] },
  'GET /api/v1/admin/rule-catalog': 'rules.publish',
  'GET /api/v1/admin/rules': 'rules.publish',
  'GET /api/v1/admin/rulesets': 'rules.publish',
  'GET /api/v1/admin/rulesets/:id': 'rules.publish',
  'GET /api/v1/admin/settings': 'settings.manage',
  'GET /api/v1/admin/slow-operations': 'diagnostics.read',
  'GET /api/v1/admin/users': 'users.manage',
  'GET /api/v1/admin/users/:id': 'users.manage',
  'GET /api/v1/audit/entries': 'audit.read',
  'GET /api/v1/auth/config': { access: 'public', modes: ['local'] },
  'GET /api/v1/bundles/:bundleId': 'markup.read',
  'GET /api/v1/bundles/:bundleId/pages': 'markup.read',
  'GET /api/v1/bundles/:bundleId/pages/:workingPageIndex': 'markup.read',
  'GET /api/v1/catalog/counterparties': 'authenticated',
  'GET /api/v1/catalog/counterparties/:counterpartyId': 'authenticated',
  'GET /api/v1/catalog/counterparty-kinds': 'authenticated',
  'GET /api/v1/catalog/doc-type-candidates': 'doc_types.manage',
  'GET /api/v1/catalog/doc-type-candidates/:candidateId': 'doc_types.manage',
  'GET /api/v1/catalog/doc-types': 'authenticated',
  'GET /api/v1/catalog/doc-types/:code': 'authenticated',
  'GET /api/v1/catalog/imports': 'settings.manage',
  'GET /api/v1/catalog/imports/:importId': 'settings.manage',
  'GET /api/v1/catalog/imports/:importId/rows': 'settings.manage',
  'GET /api/v1/catalog/imports/template': 'authenticated',
  'GET /api/v1/catalog/objects': 'authenticated',
  'GET /api/v1/catalog/objects/:objectId': 'authenticated',
  'GET /api/v1/catalog/objects/:objectId/contractors': 'authenticated',
  'GET /api/v1/catalog/objects/:objectId/rd-documents': 'authenticated',
  'GET /api/v1/catalog/objects/:objectId/rule-profiles': 'authenticated',
  'GET /api/v1/catalog/objects/:objectId/sections': 'authenticated',
  'GET /api/v1/catalog/objects/:objectId/sections/:sectionCode/effective-rules': 'authenticated',
  'GET /api/v1/catalog/section-profiles': 'authenticated',
  'GET /api/v1/catalog/sections': 'authenticated',
  'GET /api/v1/catalog/sections/:sectionCode/effective-profile': 'authenticated',
  'GET /api/v1/documents/:documentId': 'submission.read',
  'GET /api/v1/documents/:documentId/fields': 'submission.read',
  'GET /api/v1/files/:fileId/content': 'submission.read',
  'GET /api/v1/folders': 'submission.read',
  'GET /api/v1/folders/:folderId': 'submission.read',
  'GET /api/v1/folders/:folderId/bundles': 'markup.read',
  'GET /api/v1/folders/:folderId/check-report': 'submission.read',
  'GET /api/v1/folders/:folderId/checks': 'submission.read',
  'GET /api/v1/folders/:folderId/classifications': 'submission.read',
  'GET /api/v1/folders/:folderId/deletion-preview': 'submission.delete',
  'GET /api/v1/folders/:folderId/documents': 'submission.read',
  'GET /api/v1/folders/:folderId/events': 'submission.read',
  'GET /api/v1/folders/:folderId/files': 'submission.read',
  'GET /api/v1/folders/:folderId/findings': 'submission.read',
  'GET /api/v1/folders/:folderId/layouts': 'markup.read',
  'GET /api/v1/folders/:folderId/pages': 'submission.read',
  'GET /api/v1/folders/:folderId/pages/:sourcePageId/orientation': 'markup.read',
  'GET /api/v1/folders/:folderId/processing-status': 'submission.read',
  'GET /api/v1/folders/:folderId/recognition-runs': 'markup.read',
  'GET /api/v1/folders/:folderId/registry': 'submission.read',
  'GET /api/v1/layouts/:layoutId': 'markup.read',
  'GET /api/v1/layouts/:layoutId/blocks': 'markup.read',
  'GET /api/v1/objects/:objectId/folders/pipeline': {
    access: 'submission.read',
    // Список идентификаторов приезжает ОДНОЙ строкой через запятую и
    // разбирается `transform` — из JSON Schema такой формат не выводится.
    query: { folderIds: '00000000-0000-4000-8000-000000000999' },
  },
  'GET /api/v1/objects/:objectId/sections/counts': 'submission.read',
  'GET /api/v1/recognition-runs/:runId': 'markup.read',
  'GET /api/v1/recognition-runs/:runId/artifacts': 'markup.read',
  'GET /api/v1/recognition-runs/:runId/artifacts/:kind/content': 'markup.read',
  'GET /api/v1/recognition-runs/:runId/blocks': 'markup.read',
  'GET /api/v1/recognition-runs/:runId/pages': 'markup.read',
  'GET /api/v1/recognition-runs/:runId/progress': 'markup.read',
  'GET /auth/callback': { access: 'public', modes: ['sso'] },
  'GET /auth/login': 'public',
  'GET /health/live': 'public',
  'GET /health/ready': 'public',
  'GET /me': 'authenticated',
  'GET /metrics': 'public',
  'PATCH /api/v1/admin/prompts/:id': 'settings.manage',
  'PATCH /api/v1/catalog/counterparties/:counterpartyId': 'settings.manage',
  'PATCH /api/v1/catalog/doc-type-candidates/:candidateId': 'doc_types.manage',
  'PATCH /api/v1/catalog/doc-types/:code': 'doc_types.manage',
  'PATCH /api/v1/catalog/objects/:objectId': 'settings.manage',
  'PATCH /api/v1/catalog/rd-documents/:rdDocumentId': 'settings.manage',
  'PATCH /api/v1/catalog/sections/:sectionCode': 'settings.manage',
  'PATCH /api/v1/folders/:folderId': 'submission.upload',
  'PATCH /api/v1/layouts/:layoutId/blocks/:blockId': 'markup.edit',
  'POST /api/v1/admin/errors/:issueId/actions': 'settings.manage',
  'POST /api/v1/admin/jobs/:jobId/cancel': 'settings.manage',
  'POST /api/v1/admin/jobs/:jobId/retry': 'settings.manage',
  'POST /api/v1/admin/jobs/maintenance/reaper': 'settings.manage',
  'POST /api/v1/admin/prompts': 'settings.manage',
  'POST /api/v1/admin/prompts/:id/state': 'settings.manage',
  'POST /api/v1/admin/registration-requests/:id/approve': {
    access: 'users.manage',
    modes: ['local'],
  },
  'POST /api/v1/admin/registration-requests/:id/reject': {
    access: 'users.manage',
    modes: ['local'],
  },
  'POST /api/v1/admin/rulesets': 'rules.publish',
  'POST /api/v1/admin/rulesets/:id/activate': 'rules.publish',
  'POST /api/v1/admin/users': { access: 'users.manage', modes: ['local'] },
  'POST /api/v1/admin/users/:id/activate': 'users.manage',
  'POST /api/v1/admin/users/:id/deactivate': 'users.manage',
  'POST /api/v1/admin/users/:id/password': { access: 'users.manage', modes: ['local'] },
  'POST /api/v1/admin/users/:id/unlock': { access: 'users.manage', modes: ['local'] },
  'POST /api/v1/auth/login': { access: 'public', modes: ['local'] },
  'POST /api/v1/auth/password': {
    access: 'authenticated',
    modes: ['local'],
    noPositiveProbe: 'меняет пароль учётной записи, которой пользуются остальные пробы',
  },
  'POST /api/v1/auth/register': { access: 'public', modes: ['local'] },
  'POST /api/v1/catalog/counterparties': 'settings.manage',
  'POST /api/v1/catalog/counterparty-kinds': 'settings.manage',
  'POST /api/v1/catalog/doc-type-candidates/:candidateId/doc-type': 'doc_types.manage',
  'POST /api/v1/catalog/doc-type-candidates/:candidateId/map': 'doc_types.manage',
  'POST /api/v1/catalog/doc-types': 'doc_types.manage',
  'POST /api/v1/catalog/imports/:importId/apply': 'settings.manage',
  'POST /api/v1/catalog/imports/:importId/complete': 'settings.manage',
  'POST /api/v1/catalog/imports/init': 'settings.manage',
  'POST /api/v1/catalog/objects': 'settings.manage',
  'POST /api/v1/catalog/objects/:objectId/rd-documents': 'settings.manage',
  'POST /api/v1/catalog/objects/:objectId/rule-profiles': 'settings.manage',
  'POST /api/v1/catalog/rule-profiles/:profileId/publish': 'settings.manage',
  'POST /api/v1/catalog/section-profiles': 'settings.manage',
  'POST /api/v1/catalog/section-profiles/:profileId/publish': 'settings.manage',
  'POST /api/v1/catalog/sections': 'settings.manage',
  'POST /api/v1/client-errors': 'public',
  'POST /api/v1/documents/:documentId/confirm': 'document.edit',
  'POST /api/v1/folders': 'submission.upload',
  'POST /api/v1/folders/:folderId/bundle': 'markup.edit',
  'POST /api/v1/folders/:folderId/check': 'pipeline.run',
  'POST /api/v1/folders/:folderId/checks': 'checks.run',
  'POST /api/v1/folders/:folderId/files/:fileId/replacement/complete': 'submission.upload',
  'POST /api/v1/folders/:folderId/files/:fileId/replacement/init': 'submission.upload',
  'POST /api/v1/folders/:folderId/files/upload/complete': 'submission.upload',
  'POST /api/v1/folders/:folderId/files/upload/init': 'submission.upload',
  'POST /api/v1/folders/:folderId/layout': 'markup.edit',
  'POST /api/v1/folders/:folderId/markup': 'pipeline.run',
  'POST /api/v1/folders/:folderId/recognize': 'recognition.start',
  'POST /api/v1/folders/:folderId/segment': 'document.edit',
  'POST /api/v1/folders/:folderId/stop': 'pipeline.run',
  'POST /api/v1/folders/with-file': 'submission.upload',
  'POST /api/v1/layouts/:layoutId/blocks': 'markup.edit',
  'POST /api/v1/layouts/:layoutId/detect': 'markup.edit',
  'POST /api/v1/layouts/:layoutId/full-page-text': 'markup.edit',
  'POST /api/v1/layouts/:layoutId/pages/:workingPageIndex/replace-with-text': 'markup.edit',
  'POST /auth/csrf': {
    access: 'authenticated',
    noPositiveProbe:
      'вращает CSRF-токен своей же сессии: после него записи этой роли получают 403-csrf',
  },
  'POST /auth/logout': {
    access: 'authenticated',
    noPositiveProbe: 'отзывает сессию роли — следующие пробы остались бы без неё',
  },
  'PUT /api/v1/admin/settings/:key': 'settings.manage',
  'PUT /api/v1/admin/users/:id/contractor': 'users.manage',
  'PUT /api/v1/admin/users/:id/roles': 'users.manage',
  'PUT /api/v1/catalog/objects/:objectId/contractors/:contractorId': [
    'registry.manage',
    'settings.manage',
  ],
  'PUT /api/v1/catalog/objects/:objectId/sections/:sectionCode': [
    'registry.manage',
    'settings.manage',
  ],
  'PUT /api/v1/folders/:folderId/files/order': 'submission.upload',
  'PUT /api/v1/folders/:folderId/pages/:sourcePageId/manual-label': 'document.edit',
  'PUT /api/v1/folders/:folderId/pages/:sourcePageId/orientation': 'markup.edit',
  'PUT /api/v1/uploads/local': 'public',
};

function expectationOf(key: string): Expectation {
  const raw = EXPECTED[key];
  if (raw === undefined) throw new Error(`нет записи в реестре: ${key}`);
  return typeof raw === 'string' || Array.isArray(raw)
    ? { access: raw as Access }
    : (raw as Expectation);
}

function modesOf(expectation: Expectation): readonly Mode[] {
  return expectation.modes ?? (['sso', 'local'] as const);
}

/** Права, объявленные реестром. `null` — публичный либо только сессия. */
function declaredPermissions(expectation: Expectation): readonly Permission[] | null {
  const { access } = expectation;
  if (access === 'public' || access === 'authenticated') return null;
  return Array.isArray(access) ? (access as readonly Permission[]) : [access as Permission];
}

// =====================================================================
// Копия матрицы прав
// =====================================================================

/**
 * Дословная копия `PERMISSIONS` на момент написания гейта.
 *
 * Без неё гейт зелен при РАСШИРЕНИИ права: реестр говорит `folder.approve`,
 * маршрут помечен `folder.approve`, а в матрице кто-то дописал `contractor` — и
 * тест послушно проверит, что подрядчику теперь можно. Копия делает изменение
 * прав видимым в diff и требует довода.
 */
const PERMISSIONS_SNAPSHOT: Readonly<Record<string, readonly UserRole[]>> = {
  'submission.read': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'submission.upload': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'submission.submit': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'submission.delete': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'markup.read': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'markup.edit': ['contractor', 'general_contractor', 'engineer', 'admin'],
  'recognition.start': ['contractor', 'general_contractor', 'engineer', 'admin'],
  'document.edit': ['engineer', 'manager'],
  'checks.run': ['engineer', 'manager'],
  'pipeline.run': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'registry.manage': ['general_contractor', 'admin'],
  'registry.accept': ['engineer', 'manager'],
  'folder.approve': ['engineer', 'manager'],
  'folder.return': ['engineer', 'manager'],
  'folder.override': ['manager'],
  'archive.download': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'users.manage': ['admin'],
  'settings.manage': ['admin'],
  'rules.publish': ['admin'],
  'doc_types.manage': ['admin'],
  'diagnostics.read': ['admin'],
  'audit.read': ['admin'],
};

const ALL_ROLES: readonly UserRole[] = [
  'contractor',
  'general_contractor',
  'engineer',
  'manager',
  'admin',
];

// =====================================================================
// Фикстура: по одному пользователю на роль
// =====================================================================

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Подстановка вместо параметра пути: заведомо несуществующая строка. */
const ABSENT_ID = id(999);
const CONTRACTOR_ORG = id(1);

/**
 * По ОДНОЙ роли каждому пользователю.
 *
 * Иначе «роль без права» не построить: `hasPermission` смотрит на весь набор
 * ролей, и пользователь с двумя ролями прошёл бы там, где ожидается отказ.
 */
const KC: Readonly<Record<UserRole, string>> = {
  contractor: 'kc-matrix-contractor',
  general_contractor: 'kc-matrix-general',
  engineer: 'kc-matrix-engineer',
  manager: 'kc-matrix-manager',
  admin: 'kc-matrix-admin',
};

/**
 * Пользователи РАЗНЫЕ для двух режимов, и это не удобство стенда.
 *
 * Портал не даёт одной учётной записи быть и федеративной, и локальной: триггер
 * на `user_credentials` требует, чтобы у владельца пароля `kc_sub` начинался с
 * `local:`. То есть «тот же человек в обоих режимах» — состояние, которого в
 * бою не бывает, и гейт не имеет права его создавать.
 */
const USER_SSO: Readonly<Record<UserRole, string>> = {
  contractor: id(11),
  general_contractor: id(12),
  engineer: id(13),
  manager: id(14),
  admin: id(15),
};

const USER_LOCAL: Readonly<Record<UserRole, string>> = {
  contractor: id(21),
  general_contractor: id(22),
  engineer: id(23),
  manager: id(24),
  admin: id(25),
};

/**
 * У подрядчика и генподрядчика ОБЯЗАН быть `contractor_id`.
 *
 * Без него `buildScope` возвращает область `contractor-without-organization`, и
 * любая их проба даёт 403 не по тому основанию: отказ пришёл бы от области
 * видимости, а гейт проверяет право.
 */
/** Логин локального входа — адрес почты, как и в бою. */
const EMAIL: Readonly<Record<UserRole, string>> = {
  contractor: 'contractor@matrix.test',
  general_contractor: 'general@matrix.test',
  engineer: 'engineer@matrix.test',
  manager: 'manager@matrix.test',
  admin: 'admin@matrix.test',
};

const PASSWORD = 'probe-password-1@';

const NAME: Readonly<Record<UserRole, string>> = {
  contractor: 'Подрядчик',
  general_contractor: 'Генподрядчик',
  engineer: 'Инженер',
  manager: 'Руководитель',
  admin: 'Администратор',
};

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, inn, kpp, ogrn, kind)
     VALUES ('${CONTRACTOR_ORG}', 'ООО «Матрица»', '7700123459', '770901001',
             '1027700123450', 'contractor')`,
  ...ALL_ROLES.flatMap((role) => {
    // `contractor_id` обязателен подрядным ролям: без него `buildScope` даёт
    // область `contractor-without-organization`, и отказ пришёл бы от неё, а не
    // от права — то есть гейт проверял бы не то, что обещает.
    const organization =
      role === 'contractor' || role === 'general_contractor' ? `'${CONTRACTOR_ORG}'` : 'null';
    return [
      `INSERT INTO users (id, kc_sub, full_name, contractor_id, is_active)
         VALUES ('${USER_SSO[role]}', '${KC[role]}', '${NAME[role]}', ${organization}, true)`,
      `INSERT INTO users (id, kc_sub, email, full_name, contractor_id, is_active)
         VALUES ('${USER_LOCAL[role]}', 'local:${role}', '${EMAIL[role]}',
                 '${NAME[role]} (локальный)', ${organization}, true)`,
      `INSERT INTO user_roles (user_id, role) VALUES ('${USER_SSO[role]}', '${role}')`,
      `INSERT INTO user_roles (user_id, role) VALUES ('${USER_LOCAL[role]}', '${role}')`,
    ];
  }),
];

// =====================================================================
// Подъём приложений
// =====================================================================

const COMMON_ENV = {
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  CSRF_SECRET: 'csrf-secret-of-route-matrix-tests-001',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-route-matrix-tests',
  // Иначе красным станет лимит запросов, а не право: проб около тысячи.
  RATE_LIMIT_MAX: '1000000',
} as const;

const ENV = {
  sso: loadEnv({ ...COMMON_ENV, AUTH_MODE: 'dev-stub' }),
  local: loadEnv({
    ...COMMON_ENV,
    AUTH_MODE: 'local',
    AUTH_LOCAL_LOGIN_HMAC_KEY: 'login-hmac-key-of-route-matrix-tests-1',
    // Минимальная стоимость: паролей гейт не проверяет, а боевая добавила бы к
    // подъёму приложения секунды на прогрев.
    AUTH_LOCAL_SCRYPT_COST_LOG2: '15',
    // Вход паролем троттлится ОТДЕЛЬНО от общего лимита запросов (§B.7):
    // по умолчанию пять попыток с адреса, а гейту нужно войти пятью ролями.
    // Иначе красным становится защита от перебора, а не право.
    AUTH_LOCAL_LOGIN_MAX_PER_IP: '10000',
    AUTH_LOCAL_LOGIN_MAX_PER_LOGIN_HOUR: '10000',
  }),
} as const;

interface RouteSchema {
  readonly body?: unknown;
  readonly params?: unknown;
  readonly querystring?: unknown;
}

interface CollectedRoute {
  readonly key: string;
  readonly method: string;
  readonly url: string;
  readonly permissions: readonly Permission[] | null;
  readonly schema: RouteSchema;
}

let db: TestDatabase;
const apps = new Map<Mode, AppInstance>();
const collected = new Map<Mode, CollectedRoute[]>();

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) await db.exec(migration.sql);
  for (const statement of FIXTURE) await db.exec(statement);

  // Пароль один на всех: гейт проверяет права, а не стойкость входа. Хэш
  // считается настоящим кодом портала, потому что маршрут входа проверяет его
  // тем же кодом.
  const hash = await hashPassword(ENV.local, PASSWORD);
  for (const role of ALL_ROLES) {
    await db.query(
      `INSERT INTO user_credentials
         (user_id, login_key, login_display, password_hash, password_algorithm)
       VALUES ($1::uuid, $2, $3, $4, $5)`,
      [USER_LOCAL[role], EMAIL[role], EMAIL[role], hash.encoded, hash.algorithm],
    );
  }
  const pool = createTestPool(db) as unknown as Pool;

  for (const mode of ['sso', 'local'] as const) {
    const routes: CollectedRoute[] = [];
    const app = await buildApp({
      env: ENV[mode],
      pool,
      onRoute: (route: ObservedRoute) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method as string];
        for (const method of methods) {
          // Зеркальный HEAD фастифай регистрирует сам на каждый GET
          // (`exposeHeadRoutes`) с той же цепочкой preHandler: в матрице он был
          // бы вторым именем одной и той же ручки.
          if (method === 'HEAD' || method === 'OPTIONS') continue;
          routes.push({
            key: `${method} ${route.url}`,
            method,
            url: route.url,
            permissions: routePermissions(route.preHandler),
            schema: (route.schema ?? {}) as RouteSchema,
          });
        }
      },
    });
    await app.ready();
    apps.set(mode, app);
    collected.set(mode, routes);
  }
}, 300_000);

afterAll(async () => {
  for (const app of apps.values()) await app.close();
  await db.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

function appOf(mode: Mode): AppInstance {
  const app = apps.get(mode);
  if (app === undefined) throw new Error(`приложение ${mode} не поднято`);
  return app;
}

function routesOf(mode: Mode): readonly CollectedRoute[] {
  return collected.get(mode) ?? [];
}

/** Маршрут проверяется в том режиме, где он есть; при обоих — в `sso`. */
function probeMode(expectation: Expectation): Mode {
  return modesOf(expectation).includes('sso') ? 'sso' : 'local';
}

// =====================================================================
// Сэмплер: годная проба собирается из самой схемы маршрута
// =====================================================================

/**
 * Значение, проходящее схему, — из JSON Schema, выведенной из zod.
 *
 * Почему из схемы, а не руками. Тел пришлось бы написать около девяноста и
 * переписывать при каждой правке схемы; сэмплер сам подхватывает новое
 * обязательное поле. Цена признаётся честно: `refine`/`superRefine` в JSON
 * Schema НЕ переносятся (непустой патч, контрольные суммы ИНН и ОГРН,
 * `from <= to`), поэтому там сэмплер промахнётся. Промах не проходит молча — он
 * краснит анонимную пробу, и чинится строкой `body` в реестре.
 */
function sample(schema: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  let json: Record<string, unknown>;
  try {
    json = z.toJSONSchema(schema as z.ZodType, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
  } catch {
    return null;
  }
  return fromJsonSchema(json, depth);
}

function fromJsonSchema(node: Record<string, unknown>, depth: number): unknown {
  if (depth > 6) return null;

  const enumValues = node['enum'];
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  if ('const' in node) return node['const'];

  const anyOf = node['anyOf'] ?? node['oneOf'];
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    // Первая ветка: так разбирается и discriminatedUnion, и nullable.
    return fromJsonSchema(anyOf[0] as Record<string, unknown>, depth + 1);
  }

  switch (node['type']) {
    case 'object': {
      const properties = (node['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const required = (node['required'] ?? []) as readonly string[];
      const out: Record<string, unknown> = {};
      // Только обязательные поля: необязательный фильтр — лишняя работа
      // обработчика и лишний способ промахнуться.
      for (const key of required) {
        const property = properties[key];
        if (property !== undefined) out[key] = fromJsonSchema(property, depth + 1);
      }

      // Тело PATCH из одних необязательных полей.
      //
      // По JSON Schema пустой объект такую схему проходит, и сэмплер формально
      // прав. Но портал вешает на такие схемы `refine(nonEmptyPatch)` — «патч
      // не может быть пустым», — а `refine` в JSON Schema НЕ переносится, и
      // пустое тело получило бы 422 на всех трёх пробах разом. Поэтому здесь
      // подставляется ОДНО необязательное поле, и значение для него берётся из
      // той же схемы: годность доказывает схема, а не догадка.
      //
      // Ложного зелёного это дать не может: если ручка принимает и пустой
      // объект, она примет и объект с одним её же полем.
      if (required.length === 0) {
        for (const [key, property] of Object.entries(properties)) {
          const value = fromJsonSchema(property, depth + 1);
          if (value !== null && value !== undefined) {
            out[key] = value;
            break;
          }
        }
      }
      return out;
    }
    case 'array': {
      const items = node['items'] as Record<string, unknown> | undefined;
      const minItems = typeof node['minItems'] === 'number' ? node['minItems'] : 0;
      if (minItems === 0 || items === undefined) return [];
      return Array.from({ length: minItems }, () => fromJsonSchema(items, depth + 1));
    }
    case 'integer':
    case 'number': {
      const minimum = typeof node['minimum'] === 'number' ? node['minimum'] : 1;
      return Math.max(minimum, 1);
    }
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'string':
    default: {
      if (node['format'] === 'uuid') return ABSENT_ID;
      if (node['format'] === 'date-time') return '2026-01-01T00:00:00.000Z';
      if (node['format'] === 'date') return '2026-01-01';
      if (node['format'] === 'email') return 'probe@example.test';
      const pattern = node['pattern'];
      if (typeof pattern === 'string') return literalMatching(pattern);
      const minLength = typeof node['minLength'] === 'number' ? node['minLength'] : 1;
      return 'a'.repeat(Math.max(minLength, 1));
    }
  }
}

/**
 * Литерал, удовлетворяющий объявленному шаблону.
 *
 * Строку под произвольный regexp не сочинить, и пытаться не нужно: шаблонов в
 * портале наперечёт: код-слаг справочника (`^[a-z][a-z0-9_]*$`), ключ настройки
 * (слаги через точку), код правила заглавными, метка версии, дата. Поэтому
 * перебирается короткий список простых кандидатов, и берётся первый ПОДОШЕДШИЙ
 * по самому шаблону — то есть годность значения доказывает схема, а не догадка
 * автора теста.
 *
 * `null` — ни один не подошёл; тогда значение задаётся в реестре полем
 * `params`/`body`, и это заметно, потому что проба покраснеет.
 */
const PATTERN_CANDIDATES: readonly string[] = [
  'probe',
  'probe_code',
  'probe.key',
  'PROBE',
  'PROBE.CODE',
  'a',
  '1',
  '2026-01-01',
  '2026-01-01T00:00:00.000Z',
  ABSENT_ID,
];

function literalMatching(pattern: string): string | null {
  let regexp: RegExp;
  try {
    regexp = new RegExp(pattern, 'u');
  } catch {
    return null;
  }
  return PATTERN_CANDIDATES.find((candidate) => regexp.test(candidate)) ?? null;
}

/** Путь с подставленными параметрами — то, что уйдёт в роутер. */
function urlFor(route: CollectedRoute, expectation: Expectation): string {
  const params = expectation.params ?? {};
  const sampled = (sample(route.schema.params) ?? {}) as Record<string, unknown>;

  const path = route.url.replace(/:([A-Za-z0-9_]+)/gu, (_match, name: string) => {
    const override = params[name];
    if (override !== undefined) return encodeURIComponent(override);
    const fromSchema = sampled[name];
    if (typeof fromSchema === 'string' && fromSchema !== '') return encodeURIComponent(fromSchema);
    if (typeof fromSchema === 'number') return String(fromSchema);
    return ABSENT_ID;
  });

  const query = (sample(route.schema.querystring) ?? {}) as Record<string, unknown>;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || typeof value === 'object') continue;
    search.set(key, String(value));
  }
  for (const [key, value] of Object.entries(expectation.query ?? {})) search.set(key, value);
  const suffix = search.toString();
  return suffix === '' ? path : `${path}?${suffix}`;
}

function bodyFor(route: CollectedRoute, expectation: Expectation): unknown {
  if (route.method === 'GET' || route.method === 'DELETE') return undefined;
  if (expectation.body !== undefined) return expectation.body;
  if (route.schema.body === undefined) return {};
  return sample(route.schema.body) ?? {};
}

// =====================================================================
// Сессии
// =====================================================================

interface SignedIn {
  readonly cookie: string;
  readonly csrfToken: string;
}

function cookieOf(response: LightMyRequestResponse, name: string): string {
  const found = response.cookies.find((cookie) => cookie.name === name);
  if (found === undefined || found.value === '') throw new Error(`В ответе нет cookie ${name}`);
  return found.value;
}

function cookieHeader(response: LightMyRequestResponse, name: string): string {
  return `${name}=${encodeURIComponent(cookieOf(response, name))}`;
}

/**
 * Вход выполняется В ТОМ ЖЕ РЕЖИМЕ, в котором будет проба.
 *
 * Сессия dev-stub в приложении `local` недействительна, и это не изъян стенда,
 * а намеренное правило портала: `auth_mode` входит в условие действительности
 * сессии (`SessionStore.load`) — «сессия, выданная Keycloak, не должна работать
 * после перевода портала на локальный вход». Гейт обязан этому подчиняться, а
 * не обходить: иначе он проверял бы конфигурацию, которой не бывает.
 *
 * Оба входа — штатные. Сессия, собранная в тесте руками, проверяла бы фикстуру,
 * а не портал.
 */
async function signInSso(role: UserRole): Promise<SignedIn> {
  const app = appOf('sso');
  const started = await app.inject({
    method: 'GET',
    url: `/auth/login?devSub=${encodeURIComponent(KC[role])}`,
  });
  expect(started.statusCode).toBe(302);

  const location = started.headers['location'];
  if (typeof location !== 'string') throw new Error('вход не дал редиректа');
  const authorizationUrl = new URL(location);

  const completed = await app.inject({
    method: 'GET',
    url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
    headers: { cookie: cookieHeader(started, LOGIN_COOKIE) },
  });
  expect(completed.statusCode).toBe(302);

  return {
    cookie: cookieHeader(completed, SESSION_COOKIE),
    csrfToken: cookieOf(completed, CSRF_COOKIE),
  };
}

/** Форма входа отвергается без признака собственного источника (§B.7). */
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' } as const;

async function signInLocal(role: UserRole): Promise<SignedIn> {
  const response = await appOf('local').inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: SAME_ORIGIN,
    payload: { email: EMAIL[role], password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);

  return {
    cookie: cookieHeader(response, SESSION_COOKIE),
    csrfToken: cookieOf(response, CSRF_COOKIE),
  };
}

/** Вход выполняется один раз на роль и режим: каждый создаёт строку сессии. */
const sessions = new Map<string, SignedIn>();

async function sessionFor(role: UserRole, mode: Mode): Promise<SignedIn> {
  const cacheKey = `${mode}:${role}`;
  const cached = sessions.get(cacheKey);
  if (cached !== undefined) return cached;
  const fresh = mode === 'sso' ? await signInSso(role) : await signInLocal(role);
  sessions.set(cacheKey, fresh);
  return fresh;
}

// =====================================================================
// Проба
// =====================================================================

function detailOf(response: LightMyRequestResponse): string | null {
  try {
    return response.json<{ detail?: string }>().detail ?? null;
  } catch {
    return null;
  }
}

/** Запрос не дошёл до маршрута вовсе — значит проба ничего не проверила. */
function routeMissing(response: LightMyRequestResponse): boolean {
  return response.statusCode === 404 && detailOf(response) === ROUTE_MISSING;
}

async function probe(
  route: CollectedRoute,
  expectation: Expectation,
  session: SignedIn | null,
): Promise<LightMyRequestResponse> {
  const app = appOf(probeMode(expectation));
  const body = bodyFor(route, expectation);
  return app.inject({
    method: route.method as 'GET',
    url: urlFor(route, expectation),
    ...(session === null
      ? {}
      : { headers: { cookie: session.cookie, [CSRF_HEADER]: session.csrfToken } }),
    ...(body === undefined ? {} : { payload: body as object }),
  });
}

interface Failure {
  readonly key: string;
  readonly role?: UserRole;
  readonly status: number;
  readonly detail: string | null;
  readonly url: string;
}

function failure(
  route: CollectedRoute,
  expectation: Expectation,
  response: LightMyRequestResponse,
  role?: UserRole,
): Failure {
  return {
    key: route.key,
    ...(role === undefined ? {} : { role }),
    status: response.statusCode,
    detail: detailOf(response),
    url: urlFor(route, expectation),
  };
}

// =====================================================================
// Проверки
// =====================================================================

describe('роутер и реестр описывают один набор маршрутов', () => {
  it('ни одной ручки без записи и ни одной записи без ручки', () => {
    for (const mode of ['sso', 'local'] as const) {
      const inRouter = new Set(routesOf(mode).map((route) => route.key));
      const inRegistry = new Set(
        Object.keys(EXPECTED).filter((key) => modesOf(expectationOf(key)).includes(mode)),
      );

      const undeclared = [...inRouter].filter((key) => !inRegistry.has(key)).sort();
      const stale = [...inRegistry].filter((key) => !inRouter.has(key)).sort();

      expect(
        { mode, undeclared, stale },
        'ручка без записи в реестре — допишите её с ожидаемым правом; ' +
          'запись без ручки — маршрут исчез или переименован',
      ).toEqual({ mode, undeclared: [], stale: [] });
    }
  });

  it('сборщик не пуст и видит право там, где оно есть', () => {
    // Положительный контроль: без него все проверки прошли бы и при сломанном
    // сборщике, который возвращает пустой список или `null` на каждой ручке.
    const sso = routesOf('sso');
    expect(sso.length).toBeGreaterThan(100);
    expect(sso.filter((route) => route.permissions !== null).length).toBeGreaterThan(100);

    const users = sso.find((route) => route.key === 'GET /api/v1/admin/users');
    expect(users?.permissions).toEqual(['users.manage']);

    const health = sso.find((route) => route.key === 'GET /health/live');
    expect(health?.permissions).toBeNull();
  });
});

describe('объявленное право совпадает с правом на маршруте', () => {
  it('отметка стоража и запись реестра сходятся', () => {
    const wrong: unknown[] = [];
    for (const mode of ['sso', 'local'] as const) {
      for (const route of routesOf(mode)) {
        const declared = declaredPermissions(expectationOf(route.key));
        const actual = route.permissions;
        const same =
          declared === null
            ? actual === null
            : actual !== null &&
              declared.length === actual.length &&
              declared.every((permission) => actual.includes(permission));
        if (!same) wrong.push({ key: route.key, mode, declared, actual });
      }
    }
    expect(wrong).toEqual([]);
  });

  it('матрица прав не менялась мимо гейта', () => {
    // Расширение права мимо этой копии дало бы зелёный гейт, проверяющий, что
    // подрядчику теперь можно.
    expect(PERMISSIONS_SNAPSHOT).toEqual(PERMISSIONS);
  });
});

describe('матрица роль × ручка', () => {
  it('без сессии каждая закрытая ручка отвечает 401', async () => {
    const failures: Failure[] = [];
    for (const key of Object.keys(EXPECTED)) {
      const expectation = expectationOf(key);
      const mode = probeMode(expectation);
      const route = routesOf(mode).find((candidate) => candidate.key === key);
      if (route === undefined) continue;

      const response = await probe(route, expectation, null);
      const ok =
        expectation.access === 'public'
          ? response.statusCode !== 401 && !routeMissing(response)
          : response.statusCode === 401 && detailOf(response) === NEEDS_LOGIN;
      if (!ok) failures.push(failure(route, expectation, response));
    }
    // Негодная проба (тело не прошло схему → 422) краснеет ЗДЕСЬ, на самой
    // дешёвой из проверок: валидация идёт раньше preHandler.
    expect(failures).toEqual([]);
  }, 300_000);

  it('роль без права получает ровно 403 от проверки права', async () => {
    const failures: Failure[] = [];
    for (const key of Object.keys(EXPECTED)) {
      const expectation = expectationOf(key);
      const permissions = declaredPermissions(expectation);
      if (permissions === null) continue;

      const mode = probeMode(expectation);
      const route = routesOf(mode).find((candidate) => candidate.key === key);
      if (route === undefined) continue;

      const allowed = new Set(permissions.flatMap((permission) => PERMISSIONS[permission]));
      for (const role of ALL_ROLES) {
        if (allowed.has(role)) continue;
        const response = await probe(route, expectation, await sessionFor(role, mode));
        // Дословная сверка текста: она доказывает, что отказал именно
        // requirePermission, а не CSRF и не guard смены пароля.
        if (response.statusCode !== 403 || detailOf(response) !== NOT_PERMITTED) {
          failures.push(failure(route, expectation, response, role));
        }
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it('разрешённая роль сквозь проверку права проходит', async () => {
    const failures: Failure[] = [];
    for (const key of Object.keys(EXPECTED)) {
      const expectation = expectationOf(key);
      if (expectation.noPositiveProbe !== undefined) continue;
      const permissions = declaredPermissions(expectation);

      const mode = probeMode(expectation);
      const route = routesOf(mode).find((candidate) => candidate.key === key);
      if (route === undefined) continue;

      const allowed =
        permissions === null
          ? ALL_ROLES
          : [...new Set(permissions.flatMap((permission) => PERMISSIONS[permission]))];
      const role = allowed[0];
      if (role === undefined) continue;
      if (expectation.access === 'public') continue;

      const response = await probe(route, expectation, await sessionFor(role, mode));
      // 400/409/422/500 годятся: право проверяется ДО обработчика, поэтому любой
      // его ответ доказывает, что гейт пропустил. Не годится только отказ САМОЙ
      // проверки права (он опознаётся по дословному тексту, а не по статусу:
      // 403 бросают и обработчики — «Сырой архив доступен только на экране
      // диагностики» — и это бизнес-правило, а не запертое право) и «маршрута
      // нет», означающее, что проба до ручки не дошла.
      if (detailOf(response) === NOT_PERMITTED || routeMissing(response)) {
        failures.push(failure(route, expectation, response, role));
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
