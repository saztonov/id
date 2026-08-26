/**
 * Экран «Проверки» через HTTP на собранном приложении (§9, §14).
 *
 * Модуль появился вместе с S9 и до этого файла держался только чтением кода.
 * Ровно так на S3 «работал» слой наблюдаемости: скоупинг в исходнике был, а
 * достижимость и изоляция никем не проверялись. Поэтому здесь поднимается
 * штатный `buildApp()` и проверяются последствия, а не наличие вызовов:
 *
 * 1. **Изоляция подрядчиков (§1.6, non-degradable)**: чужие прогоны и чужие
 *    замечания не отдаются ни списком, ни по прямому идентификатору прогона, и
 *    секретный маркер чужой поставки не появляется в теле ответа.
 * 2. **Пустая область инженера закрывает выдачу**: `user_object_scopes` без
 *    строк — это «не видит ничего», а не «нет ограничения».
 * 3. **Право на каталог правил** (`rules.publish`) действительно разделяет
 *    роли: администратор получает каталог, остальные — 403.
 * 4. **Идемпотентность `POST .../checks`** проверяется ПО ТАБЛИЦЕ `jobs`, а не
 *    по коду ответа: 202 отдаётся и на повторе, и единственное наблюдаемое
 *    отличие — вторая строка в очереди, которой быть не должно (урок S5).
 *
 * ## Почему рядом с каждым отрицанием стоит положительный контроль
 *
 * Проверка «подрядчик Б не видит ревизию А» проходит и на сломанной выборке,
 * которая не возвращает ничего никому, и на маршруте, всегда отвечающем 403.
 * Поэтому каждое «не видит» здесь сопровождается утверждением «владелец видит,
 * и список непуст». Без этой пары тест доказывал бы отсутствие данных, а не
 * работу изоляции — тот же дефект, что S7 нашёл у проверки подписанных ссылок.
 *
 * ## Почему чужая ревизия даёт 200 с пустым списком, а не 404
 *
 * Оба GET-маршрута модуля — списки, ограниченные областью видимости в SQL
 * (`withScope`), и повторяют решение модуля документов: список чужой ревизии —
 * это 200 и `items: []`, а 404 отдаётся там, где обработчик сам ищет строку и
 * не находит её (в этом модуле — `POST .../checks`, который перед постановкой
 * задачи читает ревизию через `findRevisionForFiles`). Разнобой был бы хуже
 * любого из двух вариантов: одинаковые по смыслу отказы обязаны выглядеть
 * одинаково, иначе клиент учится различать «нет прав» и «нет данных» по коду.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LightMyRequestResponse } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgliteDatabase, createTestPool, type TestDatabase } from '@id/db-harness';
import { loadMigrations } from '@id/migrator';
import { RULE_CATALOG } from '@id/rules';

import { buildApp, type AppInstance } from '../../app.js';
import { CSRF_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE } from '../../auth/session.js';
import { loadEnv } from '../../config/env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'migrations');

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const ORG_CUSTOMER = id(1);
const ORG_A = id(2);
const ORG_B = id(3);
const OBJECT = id(4);

const SUBMISSION_A = id(10);
const REVISION_A = id(11);
const SUBMISSION_B = id(12);
const REVISION_B = id(13);

const USER_A = id(20);
const USER_B = id(21);
const USER_ENGINEER = id(22);
const USER_MANAGER = id(23);
const USER_ADMIN = id(24);
/** Инженер БЕЗ назначенных объектов: право есть, область пуста. */
const USER_ENGINEER_NO_SCOPE = id(25);

const RULESET_VERSION = id(30);
const RUN_A = id(40);
const RUN_B = id(41);
const FINDING_A = id(50);
const FINDING_B = id(51);

// Разбор комплекта А: файл, страницы, рабочий документ, документ и текст.
// Нужен целиком, потому что подпись строки «Страница 5 — сертификат
// соответствия — просрочена дата» собирается из пяти таблиц, и фикстура без
// любой из них проверяла бы не выдачу, а её вырожденный случай.
const FILE_A = id(60);
const PAGE_A0 = id(61);
const PAGE_A1 = id(62);
const PAGE_A2 = id(63);
const BUNDLE_A = id(64);
const LAYOUT_A = id(65);
const RUN_DOC_A = id(66);
const RECOGNITION_A = id(67);
const ARTIFACT_A = id(68);
const TEXT_A0 = id(69);
const DOCUMENT_A = id(70);

/** Ревизия с двумя прогонами: авторитетный тот, что новее. */
const SUBMISSION_C = id(80);
const REVISION_C = id(81);
const RUN_C_OLD = id(82);
const RUN_C_NEW = id(83);
const FINDING_C_OLD = id(84);
const FINDING_C_NEW = id(85);

/**
 * Ревизия Г — комплект полного состава для отчёта (S29).
 *
 * Отдельная ревизия, а не расширение А: тесты покрытия утверждают точные числа
 * страниц и документов ревизии А, и дописать туда акт с реестром значило бы
 * переписать их ради фикстуры соседнего теста.
 */
const SUBMISSION_D = id(90);
const REVISION_D = id(91);
const FILE_D = id(92);
const PAGE_D0 = id(93);
const PAGE_D1 = id(94);
const PAGE_D2 = id(95);
const PAGE_D3 = id(96);
const PAGE_D4 = id(97);
const BUNDLE_D = id(98);
const DOC_D_ACT = id(100);
const DOC_D_REGISTRY = id(101);
const DOC_D_CERT = id(102);
const DOC_D_PASSPORT = id(103);
const RUN_D = id(104);
const FINDING_D_ACT = id(105);
const FINDING_D_CERT = id(106);
const FINDING_D_MATERIAL = id(107);
const REG_ROW_MATCHED = id(108);
const REG_ROW_MISSING = id(109);
/** Ревизия без единого прогона правил: состав виден, проверки не было. */
const SUBMISSION_E = id(110);
const REVISION_E = id(111);
const DOC_E = id(112);

const SHA = (letter: string): string => letter.repeat(64);

/** Код из реестра правил (seed 0017): `findings.rule_code` — внешний ключ. */
const RULE_CODE = 'AOSR.ACT.030';

/**
 * Маркер чужих данных.
 *
 * Лежит в тексте замечания поставки Б и в сводке её прогона. Утверждение «в
 * ответе нет маркера» имеет смысл только потому, что владелец его ПОЛУЧАЕТ —
 * это проверяется отдельным тестом рядом.
 */
const SECRET = 'СЕКРЕТНЫЙ-ФРАГМЕНТ-ПРОВЕРОК-Б';

const KC = {
  a: 'kc-checks-a',
  b: 'kc-checks-b',
  engineer: 'kc-checks-engineer',
  manager: 'kc-checks-manager',
  admin: 'kc-checks-admin',
  engineerNoScope: 'kc-checks-engineer-no-scope',
} as const;

const FIXTURE: readonly string[] = [
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_CUSTOMER}', 'ООО «Застройщик»', 'customer')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_A}', 'ООО «Подрядчик А»', 'contractor')`,
  `INSERT INTO counterparties (id, name, kind) VALUES ('${ORG_B}', 'ООО «Подрядчик Б»', 'contractor')`,
  `INSERT INTO construction_objects (id, code, name, full_name)
     VALUES ('${OBJECT}', 'TST01', 'Объект 1', 'ЖК «Тест», корпус 1')`,
  `INSERT INTO sections (code, name) VALUES ('roofing', 'Кровля автостоянки') ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${OBJECT}', 'roofing') ON CONFLICT DO NOTHING`,

  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_A}', '${KC.a}', 'Сотрудник А', '${ORG_A}')`,
  `INSERT INTO users (id, kc_sub, full_name, contractor_id)
     VALUES ('${USER_B}', '${KC.b}', 'Сотрудник Б', '${ORG_B}')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ENGINEER}', '${KC.engineer}', 'Инженер')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_MANAGER}', '${KC.manager}', 'Руководитель')`,
  `INSERT INTO users (id, kc_sub, full_name) VALUES ('${USER_ADMIN}', '${KC.admin}', 'Администратор')`,
  `INSERT INTO users (id, kc_sub, full_name)
     VALUES ('${USER_ENGINEER_NO_SCOPE}', '${KC.engineerNoScope}', 'Инженер без объектов')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_A}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_B}', 'contractor')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER}', 'engineer')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_MANAGER}', 'manager')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ADMIN}', 'admin')`,
  `INSERT INTO user_roles (user_id, role) VALUES ('${USER_ENGINEER_NO_SCOPE}', 'engineer')`,
  `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${USER_ENGINEER}', '${OBJECT}')`,

  // Опубликованный набор правил: прогон по черновику §3.7 запрещает.
  `INSERT INTO ruleset_versions (id, version, published_at, published_by)
     VALUES ('${RULESET_VERSION}', '2026.1', now(), '${USER_ADMIN}')`,

  // --- Поставка А ------------------------------------------------------------
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_A}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_A}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-01-01', 'Поставка А', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_A}', '${SUBMISSION_A}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
  // Разбор комплекта А. Три страницы: две отнесены к сертификату, третья
  // осталась непривязанной с названной причиной — именно её считает сводка
  // покрытия, а не пустое `v_unaccounted_pages`.
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('a')}', 'blobs/${SHA('a')}', 2048, 'application/pdf')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('b')}', 'blobs/${SHA('b')}', 4096, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_A}', '${REVISION_A}', '${SHA('a')}', 'komplekt.pdf', 0, 'ok')`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A0}', '${REVISION_A}', '${FILE_A}', 0, 0, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A1}', '${REVISION_A}', '${FILE_A}', 1, 1, 1654, 2339, 0)`,
  `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
     VALUES ('${PAGE_A2}', '${REVISION_A}', '${FILE_A}', 2, 2, 1654, 2339, 0)`,
  `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE_A}', '${REVISION_A}', '${SHA('e')}', '${SHA('b')}', 'bundle/1+pdf-lib')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_A}', '${REVISION_A}', 0, '${PAGE_A0}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_A}', '${REVISION_A}', 1, '${PAGE_A1}')`,
  `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
     VALUES ('${BUNDLE_A}', '${REVISION_A}', 2, '${PAGE_A2}')`,
  `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
     VALUES ('${LAYOUT_A}', '${REVISION_A}', '${OBJECT}', '${BUNDLE_A}', 1, 'draft')`,
  // Хэш набора блоков отдельным UPDATE: он появляется у разметки не при
  // создании, а когда по ней стартовал прогон распознавания.
  `UPDATE layout_revisions SET blocks_hash = '${SHA('7')}'
     WHERE id = '${LAYOUT_A}'`,
  `INSERT INTO rd_run_documents (id, layout_revision_id, rd_document_id, rd_project_id)
     VALUES ('${RUN_DOC_A}', '${LAYOUT_A}', 'doc_a', 'prj-portal')`,
  `INSERT INTO recognition_runs (id, revision_id, layout_revision_id, rd_run_document_id,
                                 local_layout_hash, working_pdf_sha256, status, finished_at)
     VALUES ('${RECOGNITION_A}', '${REVISION_A}', '${LAYOUT_A}', '${RUN_DOC_A}',
             '${SHA('7')}', '${SHA('b')}', 'done', now())`,
  `INSERT INTO artifact_versions (id, recognition_run_id, kind, s3_key, artifact_sha256, byte_size)
     VALUES ('${ARTIFACT_A}', '${RECOGNITION_A}', 'md', 'artifacts/a.md', '${SHA('4')}', 20)`,
  `INSERT INTO page_text_versions (id, revision_id, source_page_id, recognition_run_id,
                                   artifact_version_id, text_md, text_sha256)
     VALUES ('${TEXT_A0}', '${REVISION_A}', '${PAGE_A0}', '${RECOGNITION_A}', '${ARTIFACT_A}',
             'СЕРТИФИКАТ СООТВЕТСТВИЯ действителен до 12.03.2024', '${SHA('6')}')`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title)
     VALUES ('${DOCUMENT_A}', '${REVISION_A}', '${OBJECT}', '${ORG_A}', 'cert_conformity', 0, 'Сертификат № 42')`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_A}', '${PAGE_A0}', '${DOCUMENT_A}', 0)`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_A}', '${PAGE_A1}', '${DOCUMENT_A}', 1)`,
  `INSERT INTO page_assignments (revision_id, source_page_id, reason)
     VALUES ('${REVISION_A}', '${PAGE_A2}', 'вид документа не определён')`,

  `INSERT INTO validation_runs (id, revision_id, ruleset_version_id, finished_at, counts)
     VALUES ('${RUN_A}', '${REVISION_A}', '${RULESET_VERSION}', now(),
             '{"error": 1, "warning": 0}'::jsonb)`,
  // Замечание уровня ДОКУМЕНТА и без страницы: страницу выдача обязана вывести
  // из первой страницы документа и честно назвать это приблизительным.
  `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                         severity, state, origin, is_blocking, target_type, target_id, message, hint)
     VALUES ('${FINDING_A}', '${RUN_A}', '${REVISION_A}', '${OBJECT}', '${ORG_A}', '${RULE_CODE}',
             'error', 'open', 'deterministic', true, 'document', '${DOCUMENT_A}',
             'Номер акта не соответствует шаблону объекта.', 'Проверьте нумерацию актов.')`,
  `INSERT INTO finding_evidence (finding_id, page_text_version_id, char_span, quote)
     VALUES ('${FINDING_A}', '${TEXT_A0}', int4range(24, 51), 'действителен до 12.03.2024')`,

  // --- Поставка Б: те же сущности, но с маркером -----------------------------
  `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${OBJECT}', '${ORG_B}') ON CONFLICT DO NOTHING`,
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_B}', '${OBJECT}', '${ORG_B}', '${ORG_B}', 'roofing', DATE '2026-01-01', 'Поставка Б', '${USER_B}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_B}', '${SUBMISSION_B}', '${OBJECT}', '${ORG_B}', 1, 'draft')`,
  `INSERT INTO validation_runs (id, revision_id, ruleset_version_id, finished_at, counts)
     VALUES ('${RUN_B}', '${REVISION_B}', '${RULESET_VERSION}', now(),
             '{"error": 1, "note": "${SECRET}"}'::jsonb)`,
  `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                         severity, state, origin, is_blocking, target_type, target_id, message, hint)
     VALUES ('${FINDING_B}', '${RUN_B}', '${REVISION_B}', '${OBJECT}', '${ORG_B}', '${RULE_CODE}',
             'error', 'open', 'deterministic', true, 'revision', '${REVISION_B}',
             '${SECRET}', 'Подсказка поставки Б.')`,

  // --- Поставка В: два прогона, второй новее -------------------------------
  //
  // `saveFindings` заменяет строки только своего прогона, поэтому в базе
  // законно лежат замечания обоих. Выдача обязана показывать один — иначе
  // второе нажатие «Распознать» удваивало бы список.
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_C}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-02-01', 'Поставка В', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_C}', '${SUBMISSION_C}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
  `INSERT INTO validation_runs (id, revision_id, ruleset_version_id, started_at, finished_at)
     VALUES ('${RUN_C_OLD}', '${REVISION_C}', '${RULESET_VERSION}',
             now() - interval '2 hours', now() - interval '2 hours')`,
  `INSERT INTO validation_runs (id, revision_id, ruleset_version_id, started_at, finished_at)
     VALUES ('${RUN_C_NEW}', '${REVISION_C}', '${RULESET_VERSION}',
             now() - interval '1 hour', now() - interval '1 hour')`,
  `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                         severity, state, origin, is_blocking, target_type, target_id, message)
     VALUES ('${FINDING_C_OLD}', '${RUN_C_OLD}', '${REVISION_C}', '${OBJECT}', '${ORG_A}', '${RULE_CODE}',
             'error', 'open', 'deterministic', true, 'revision', '${REVISION_C}',
             'Замечание прошлого прогона.')`,
  `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                         severity, state, origin, is_blocking, target_type, target_id, message)
     VALUES ('${FINDING_C_NEW}', '${RUN_C_NEW}', '${REVISION_C}', '${OBJECT}', '${ORG_A}', '${RULE_CODE}',
             'warning', 'open', 'deterministic', false, 'revision', '${REVISION_C}',
             'Замечание последнего прогона.')`,

  // --- Поставка Г: комплект полного состава для отчёта -----------------------
  //
  // Акт, реестр приложений с двумя строками (одна сошлась, вторая нет),
  // сертификат со сроком и паспорт. Плюс замечание о материале, которому места
  // ни в одной строке отчёта нет по построению.
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_D}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-03-01', 'Поставка Г', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_D}', '${SUBMISSION_D}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
  `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
     VALUES ('${SHA('d')}', 'blobs/${SHA('d')}', 8192, 'application/pdf')`,
  `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
     VALUES ('${FILE_D}', '${REVISION_D}', '${SHA('d')}', 'komplekt-g.pdf', 0, 'ok')`,
  ...[PAGE_D0, PAGE_D1, PAGE_D2, PAGE_D3, PAGE_D4].map(
    (page, index) =>
      `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal, width_px, height_px, rotation)
         VALUES ('${page}', '${REVISION_D}', '${FILE_D}', ${String(index)}, ${String(index)}, 1654, 2339, 0)`,
  ),
  `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
     VALUES ('${BUNDLE_D}', '${REVISION_D}', '${SHA('c')}', '${SHA('d')}', 'bundle/1+pdf-lib')`,
  ...[PAGE_D0, PAGE_D1, PAGE_D2, PAGE_D3, PAGE_D4].map(
    (page, index) =>
      `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
         VALUES ('${BUNDLE_D}', '${REVISION_D}', ${String(index)}, '${page}')`,
  ),
  // Порядок вставки НАРОЧНО обратный порядку страниц: отчёт обязан упорядочить
  // документы по первой странице, а не по `ordinal` и не по порядку в таблице.
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title)
     VALUES ('${DOC_D_PASSPORT}', '${REVISION_D}', '${OBJECT}', '${ORG_A}', 'quality_passport', 0, 'Паспорт')`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title)
     VALUES ('${DOC_D_CERT}', '${REVISION_D}', '${OBJECT}', '${ORG_A}', 'cert_conformity', 1, 'Сертификат')`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title)
     VALUES ('${DOC_D_REGISTRY}', '${REVISION_D}', '${OBJECT}', '${ORG_A}', 'annex_registry', 2, 'Реестр приложений')`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title)
     VALUES ('${DOC_D_ACT}', '${REVISION_D}', '${OBJECT}', '${ORG_A}', 'aosr', 3, 'АОСР')`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_D}', '${PAGE_D0}', '${DOC_D_ACT}', 0)`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_D}', '${PAGE_D1}', '${DOC_D_ACT}', 1)`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_D}', '${PAGE_D2}', '${DOC_D_REGISTRY}', 0)`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_D}', '${PAGE_D3}', '${DOC_D_CERT}', 0)`,
  `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order)
     VALUES ('${REVISION_D}', '${PAGE_D4}', '${DOC_D_PASSPORT}', 0)`,
  `INSERT INTO field_values (revision_id, document_id, field_code, value_text, extractor_version, extracted_by)
     VALUES ('${REVISION_D}', '${DOC_D_ACT}', 'act_number', '01-Бл-П', 'extract/1', 'rule')`,
  `INSERT INTO field_values (revision_id, document_id, field_code, value_text, extractor_version, extracted_by)
     VALUES ('${REVISION_D}', '${DOC_D_CERT}', 'number', 'РОСС RU.0001', 'extract/1', 'rule')`,
  `INSERT INTO field_values (revision_id, document_id, field_code, value_date, extractor_version, extracted_by)
     VALUES ('${REVISION_D}', '${DOC_D_CERT}', 'issued_at', DATE '2023-03-12', 'extract/1', 'rule')`,
  `INSERT INTO field_values (revision_id, document_id, field_code, value_date, extractor_version, extracted_by)
     VALUES ('${REVISION_D}', '${DOC_D_CERT}', 'valid_to', DATE '2024-03-12', 'extract/1', 'rule')`,
  `INSERT INTO registry_rows (id, revision_id, document_id, row_no, ordinal, doc_name_raw, doc_no_raw, org_raw,
                              matched_document_id, match_score, match_state)
     VALUES ('${REG_ROW_MATCHED}', '${REVISION_D}', '${DOC_D_REGISTRY}', 1, 0,
             'Документ о качестве', 'РОСС RU.0001', 'ООО «Завод»',
             '${DOC_D_CERT}', 1, 'matched')`,
  `INSERT INTO registry_rows (id, revision_id, document_id, row_no, ordinal, doc_name_raw, doc_no_raw, match_state)
     VALUES ('${REG_ROW_MISSING}', '${REVISION_D}', '${DOC_D_REGISTRY}', 2, 1,
             'Паспорт качества', '16005', 'missing')`,
  // Журнал исполнения: чек-лист акта показывается по нему, а не по замечаниям.
  // Четыре пункта нарочно разного исхода — пройденный, провалившийся,
  // неприменимый и не исполнявшийся: галочка обязана достаться только первому.
  `INSERT INTO validation_runs (id, revision_id, ruleset_version_id, started_at, finished_at, counts)
     VALUES ('${RUN_D}', '${REVISION_D}', '${RULESET_VERSION}', now(), now(), '{
       "journal": {
         "engineVersion": "checks/1",
         "rulesetVersion": "2026.1",
         "executions": [
           {"ruleCode": "AOSR.HDR.020", "verdict": "pass", "reason": null, "findingCount": 0},
           {"ruleCode": "AOSR.HDR.021", "verdict": "fail", "reason": null, "findingCount": 1},
           {"ruleCode": "AOSR.P3.070", "verdict": "n_a", "reason": "профиль раздела не настроен", "findingCount": 0}
         ],
         "skippedCodes": {"AOSR.ACT.032": "not_in_profile"},
         "externalRegistriesUnavailable": [],
         "engineCounts": {}
       }
     }'::jsonb)`,
  `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                         severity, state, origin, is_blocking, target_type, target_id, message)
     VALUES ('${FINDING_D_ACT}', '${RUN_D}', '${REVISION_D}', '${OBJECT}', '${ORG_A}', 'AOSR.HDR.021',
             'error', 'open', 'deterministic', true, 'document', '${DOC_D_ACT}',
             'Контрольная сумма ИНН в шапке акта не сходится.')`,
  `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                         severity, state, origin, is_blocking, target_type, target_id, message)
     VALUES ('${FINDING_D_CERT}', '${RUN_D}', '${REVISION_D}', '${OBJECT}', '${ORG_A}', 'DATE.302',
             'warning', 'open', 'deterministic', false, 'document', '${DOC_D_CERT}',
             'Документ истёк 12.03.2024.')`,
  `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                         severity, state, origin, is_blocking, target_type, target_id, message)
     VALUES ('${FINDING_D_MATERIAL}', '${RUN_D}', '${REVISION_D}', '${OBJECT}', '${ORG_A}', 'MAT.110',
             'error', 'open', 'deterministic', false, 'material', '${id(199)}',
             'На материал нет документа о качестве.')`,

  // --- Поставка Д: состав есть, проверки не было ----------------------------
  `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${SUBMISSION_E}', '${OBJECT}', '${ORG_A}', '${ORG_A}', 'roofing', DATE '2026-04-01', 'Поставка Д', '${USER_A}')`,
  `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${REVISION_E}', '${SUBMISSION_E}', '${OBJECT}', '${ORG_A}', 1, 'draft')`,
  `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title)
     VALUES ('${DOC_E}', '${REVISION_E}', '${OBJECT}', '${ORG_A}', 'cert_conformity', 0, 'Сертификат Д')`,
];

const STORAGE_DIR = mkdtempSync(join(tmpdir(), 'id-checks-routes-'));

const TEST_ENV = loadEnv({
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://pglite/id-portal-tests',
  AUTH_MODE: 'dev-stub',
  CSRF_SECRET: 'csrf-secret-of-checks-tests-0123456789',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: STORAGE_DIR,
  AUDIT_HMAC_KEY: 'audit-hmac-key-of-checks-tests',
  RATE_LIMIT_MAX: '100000',
  RDWEB_BASE_URL: 'http://127.0.0.1:1/',
  RDWEB_USER: 'portal@example.test',
  RDWEB_PASSWORD: 'portal-secret-of-tests',
  RDWEB_PROJECT_ALLOWLIST: 'prj-portal',
  RDWEB_OCR_MODEL: 'qwen2.5-vl-7b',
});

let db: TestDatabase;
let app: AppInstance;

beforeAll(async () => {
  db = await createPgliteDatabase();
  for (const migration of loadMigrations(MIGRATIONS_DIR)) {
    await db.exec(migration.sql);
  }
  for (const statement of FIXTURE) {
    await db.query(statement);
  }
  app = await buildApp({ env: TEST_ENV, pool: createTestPool(db) as unknown as Pool });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app.close();
  await db.close();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

type Method = 'GET' | 'POST';

interface SignedIn {
  readonly cookie: string;
  readonly csrfToken: string;
}

function cookieOf(response: LightMyRequestResponse, name: string): string {
  const found = response.cookies.filter((cookie) => cookie.name === name).at(-1);
  if (found === undefined || found.value === '') throw new Error(`В ответе нет cookie ${name}`);
  return found.value;
}

function cookieHeader(response: LightMyRequestResponse, name: string): string {
  return `${name}=${encodeURIComponent(cookieOf(response, name))}`;
}

async function signIn(kcSub: string): Promise<SignedIn> {
  const started = await app.inject({
    method: 'GET',
    url: `/auth/login?devSub=${encodeURIComponent(kcSub)}`,
  });
  const location = started.headers['location'];
  if (typeof location !== 'string') throw new Error('нет location');
  const authorizationUrl = new URL(location);
  const completed = await app.inject({
    method: 'GET',
    url: `${authorizationUrl.pathname}${authorizationUrl.search}`,
    headers: { cookie: cookieHeader(started, LOGIN_COOKIE) },
  });
  return {
    cookie: cookieHeader(completed, SESSION_COOKIE),
    csrfToken: cookieOf(completed, CSRF_COOKIE),
  };
}

const signedIn = new Map<string, SignedIn>();

async function as(
  kcSub: string,
  method: Method,
  url: string,
  options: { readonly body?: unknown; readonly idempotencyKey?: string | null } = {},
): Promise<LightMyRequestResponse> {
  let session = signedIn.get(kcSub);
  if (session === undefined) {
    session = await signIn(kcSub);
    signedIn.set(kcSub, session);
  }
  return app.inject({
    method,
    url,
    headers: {
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrfToken,
      ...(options.idempotencyKey !== undefined && options.idempotencyKey !== null
        ? { 'idempotency-key': options.idempotencyKey }
        : {}),
    },
    ...(options.body !== undefined ? { payload: options.body as object } : {}),
  });
}

interface ItemsOf {
  readonly items: readonly Record<string, unknown>[];
}

function items(response: LightMyRequestResponse): readonly Record<string, unknown>[] {
  return response.json<ItemsOf>().items;
}

/** Формы обогащённой выдачи: то же, что видит браузер. */
interface EnrichedFinding {
  readonly sourcePageId: string | null;
  readonly page: { number: number; workingPageIndex: number | null; basis: string } | null;
  readonly document: { id: string; docTypeCode: string | null; label: string } | null;
  readonly target: { kind: string; label: string; detail: string | null };
  readonly evidence: readonly {
    quote: string;
    charSpan: { start: number; end: number };
  }[];
}

interface ChecksSummaryOf {
  readonly summary: {
    readonly latestRun: { id: string; startedAt: string; finishedAt: string | null } | null;
    readonly shownRunId: string | null;
    readonly coverage: {
      pagesTotal: number;
      pagesRecognized: number;
      pagesAssigned: number;
      pagesUnassigned: number;
      unassignedPageNumbers: number[];
      documentsTotal: number;
      documentsUnknownType: number;
    };
    readonly counts: {
      openErrors: number;
      openWarnings: number;
      openInfo: number;
      undetermined: number;
      waived: number;
    };
  };
}

function summaryOf(response: LightMyRequestResponse): ChecksSummaryOf['summary'] {
  return response.json<ChecksSummaryOf>().summary;
}

/**
 * Ключ дедупликации, который строит роут: `checks.run:<ревизия>:<заголовок>`.
 *
 * Повторён здесь буквально, а не импортирован из `dedupeKeyFor`: тест обязан
 * знать, ЧТО попадёт в колонку, иначе смена формата ключа в роуте молча
 * переставала бы дедуплицировать, а проверка продолжала бы проходить.
 */
function dedupeKey(revisionId: string, header: string): string {
  return `checks.run:${revisionId}:${header}`;
}

async function jobsByKey(key: string): Promise<readonly { id: string; payload: string }[]> {
  return db.query<{ id: string; payload: string }>(
    `SELECT id, payload::text AS payload FROM jobs
      WHERE type = 'checks.run' AND dedupe_key = '${key}' ORDER BY created_at`,
  );
}

async function totalCheckJobs(): Promise<number> {
  const rows = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM jobs WHERE type = 'checks.run'`,
  );
  return Number(rows[0]?.n ?? 0);
}

// =====================================================================
// GET /revisions/{id}/findings — изоляция (§1.6, non-degradable)
// =====================================================================

describe('GET /api/v1/revisions/{id}/findings', () => {
  it('владелец получает СВОИ замечания, и список непуст', async () => {
    const a = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/findings`);
    expect(a.statusCode).toBe(200);
    expect(items(a)).toHaveLength(1);
    expect(items(a)[0]?.id).toBe(FINDING_A);
    expect(items(a)[0]?.ruleCode).toBe(RULE_CODE);

    // Владелец поставки Б получает маркер — без этого утверждения проверка
    // «маркера нет в ответе подрядчика А» доказывала бы лишь, что его нет нигде.
    const b = await as(KC.b, 'GET', `/api/v1/revisions/${REVISION_B}/findings`);
    expect(b.statusCode).toBe(200);
    expect(items(b)).toHaveLength(1);
    expect(b.body).toContain(SECRET);
  });

  it('подрядчик А не получает замечаний ревизии Б ни списком, ни по прямому прогону', async () => {
    const list = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/findings`);
    expect(list.statusCode).toBe(200);
    expect(items(list)).toEqual([]);
    expect(list.body).not.toContain(SECRET);

    // Прямое обращение по идентификатору чужого прогона — второй путь к тем же
    // строкам, и он обязан быть закрыт тем же условием области.
    const byRun = await as(
      KC.a,
      'GET',
      `/api/v1/revisions/${REVISION_B}/findings?validationRunId=${RUN_B}`,
    );
    expect(byRun.statusCode).toBe(200);
    expect(items(byRun)).toEqual([]);
    expect(byRun.body).not.toContain(SECRET);

    // Чужой прогон, подставленный к СВОЕЙ ревизии, тоже не должен ничего
    // подтягивать: фильтр по прогону не заменяет фильтр по ревизии.
    const crossed = await as(
      KC.a,
      'GET',
      `/api/v1/revisions/${REVISION_A}/findings?validationRunId=${RUN_B}`,
    );
    expect(items(crossed)).toEqual([]);
    expect(crossed.body).not.toContain(SECRET);

    // Положительный контроль в том же тесте: выборка подрядчика А жива, и
    // пустые ответы выше — следствие изоляции, а не общей поломки маршрута.
    const own = await as(
      KC.a,
      'GET',
      `/api/v1/revisions/${REVISION_A}/findings?validationRunId=${RUN_A}`,
    );
    expect(items(own)).toHaveLength(1);
  });

  it('инженер объекта видит замечания ОБОИХ подрядчиков', async () => {
    const a = await as(KC.engineer, 'GET', `/api/v1/revisions/${REVISION_A}/findings`);
    expect(items(a)).toHaveLength(1);

    const b = await as(KC.engineer, 'GET', `/api/v1/revisions/${REVISION_B}/findings`);
    expect(items(b)).toHaveLength(1);
    expect(b.body).toContain(SECRET);
  });

  it('инженер без назначенных объектов не видит ничего', async () => {
    for (const revision of [REVISION_A, REVISION_B]) {
      const response = await as(
        KC.engineerNoScope,
        'GET',
        `/api/v1/revisions/${revision}/findings`,
      );
      // 200 с пустым списком, а не 403: право `submission.read` у роли есть,
      // пуста именно область видимости (§4.1, второй уровень).
      expect(response.statusCode).toBe(200);
      expect(items(response)).toEqual([]);
      expect(response.body).not.toContain(SECRET);
    }

    // Положительный контроль: те же URL под инженером с объектом непусты.
    const scoped = await as(KC.engineer, 'GET', `/api/v1/revisions/${REVISION_B}/findings`);
    expect(items(scoped)).toHaveLength(1);
  });

  it('время чужого прогона не утекает в сводку', async () => {
    // Утечка тоньше, чем «видно чужое замечание»: список пуст, а `latestRun`
    // рассказывал бы, что проверка соседа шла вчера в 14:20. Это тот же класс
    // сведения о чужой работе, что счётчики чужой папки (§16).
    const foreign = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/findings`);
    expect(summaryOf(foreign).latestRun).toBeNull();

    const own = await as(KC.b, 'GET', `/api/v1/revisions/${REVISION_B}/findings`);
    expect(summaryOf(own).latestRun).not.toBeNull();
  });
});

// =====================================================================
// Подпись строки: «Страница N — вид документа — что не так»
// =====================================================================

describe('обогащение замечаний', () => {
  it('называет вид документа из справочника, а не код типа', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/findings`);
    const finding = items(response)[0] as unknown as EnrichedFinding;

    expect(finding.document?.docTypeCode).toBe('cert_conformity');
    // Название приходит из `doc_types`, а не из каталога в коде: администратор
    // заводит и переименовывает виды в портале, и второй источник разъехался бы.
    expect(finding.document?.label).toBe('Сертификат соответствия');
    expect(finding.target.kind).toBe('document');
  });

  it('выводит страницу из начала документа и НАЗЫВАЕТ это приблизительным', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/findings`);
    const finding = items(response)[0] as unknown as EnrichedFinding;

    // У замечания нет своей страницы: `source_page_id` пуст. Без вывода из
    // документа половина списка осталась бы без номера и форма «Страница N —
    // вид — что не так» не собралась бы вовсе.
    expect(finding.sourcePageId).toBeNull();
    expect(finding.page?.number).toBe(1);
    // Доказательство точнее начала документа: цитата лежит на первой странице,
    // и приоритет обязан выбрать её, а не запасной вариант.
    expect(finding.page?.basis).toBe('evidence');
    // Номер страницы рабочего документа — для ссылки на разметку.
    expect(finding.page?.workingPageIndex).toBe(0);
  });

  it('отдаёт цитату доказательства — она заменяет удалённый раздел «Реквизиты»', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/findings`);
    const finding = items(response)[0] as unknown as EnrichedFinding;

    expect(finding.evidence).toHaveLength(1);
    expect(finding.evidence[0]?.quote).toBe('действителен до 12.03.2024');
    expect(finding.evidence[0]?.charSpan).toEqual({ start: 24, end: 51 });
  });

  it('сводка различает распознанное, разобранное и непривязанное', async () => {
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/findings`);
    const { coverage, counts } = summaryOf(response);

    expect(coverage.pagesTotal).toBe(3);
    expect(coverage.pagesRecognized).toBe(1);
    expect(coverage.pagesAssigned).toBe(2);
    // Непривязанная страница — это `page_assignments` с пустым документом, а
    // НЕ `v_unaccounted_pages`: последнее после успешной сегментации пусто по
    // построению, потому что её транзакция откатывается на непустом.
    expect(coverage.pagesUnassigned).toBe(1);
    expect(coverage.unassignedPageNumbers).toEqual([3]);
    expect(coverage.documentsTotal).toBe(1);

    expect(counts.openErrors).toBe(1);
    expect(counts.openWarnings).toBe(0);
    expect(counts.undetermined).toBe(0);
  });

  it('цель, исчезнувшая после пересборки, названа словами, а не пустой ячейкой', async () => {
    // Пустая подпись читалась бы как дефект вёрстки, а это свойство данных:
    // прогон описывал документы, которых больше нет.
    await db.exec(`UPDATE findings SET target_id = '${id(999)}' WHERE id = '${FINDING_A}'`);
    try {
      const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/findings`);
      const finding = items(response)[0] as unknown as EnrichedFinding;
      expect(finding.target.kind).toBe('gone');
      expect(finding.target.label).toContain('пересобран');
    } finally {
      await db.exec(`UPDATE findings SET target_id = '${DOCUMENT_A}' WHERE id = '${FINDING_A}'`);
    }
  });
});

// =====================================================================
// Авторитетный прогон
// =====================================================================

describe('прогон, который показывается', () => {
  it('показывает последний прогон, а не сумму всех', async () => {
    // Ровно тот дефект, из-за которого второе нажатие «Распознать» удваивало
    // список: `saveFindings` заменяет строки только своего прогона, а выдача
    // читала всю ревизию.
    const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_C}/findings`);
    expect(items(response)).toHaveLength(1);
    expect(items(response)[0]?.id).toBe(FINDING_C_NEW);
    expect(summaryOf(response).shownRunId).toBe(RUN_C_NEW);
  });

  it('идущая проверка не гасит прежний результат, но видна отдельно', async () => {
    await db.exec(`UPDATE validation_runs SET finished_at = NULL WHERE id = '${RUN_C_NEW}'`);
    try {
      const response = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_C}/findings`);
      const summary = summaryOf(response);

      // Авторитетный — новый и незавершённый: по нему запирается согласование.
      expect(summary.latestRun?.id).toBe(RUN_C_NEW);
      expect(summary.latestRun?.finishedAt).toBeNull();
      // Показан предыдущий завершённый: гасить экран значило бы вернуть ту
      // пустоту, из-за которой вкладку и переделывали.
      expect(summary.shownRunId).toBe(RUN_C_OLD);
      expect(items(response)[0]?.id).toBe(FINDING_C_OLD);
    } finally {
      await db.exec(
        `UPDATE validation_runs SET finished_at = now() - interval '1 hour' WHERE id = '${RUN_C_NEW}'`,
      );
    }
  });

  it('явный прогон задаёт и список, и счётчики', async () => {
    // Иначе ответ был бы внутренне противоречив: items одной проверки, сводка
    // другой, и по нему нельзя понять, что именно проверяли.
    const response = await as(
      KC.a,
      'GET',
      `/api/v1/revisions/${REVISION_C}/findings?validationRunId=${RUN_C_OLD}`,
    );
    expect(items(response)[0]?.id).toBe(FINDING_C_OLD);
    expect(summaryOf(response).shownRunId).toBe(RUN_C_OLD);
    expect(summaryOf(response).counts.openErrors).toBe(1);
  });
});

// =====================================================================
// GET /revisions/{id}/checks — изоляция
// =====================================================================

describe('GET /api/v1/revisions/{id}/checks', () => {
  it('владелец получает СВОИ прогоны, и список непуст', async () => {
    const a = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/checks`);
    expect(a.statusCode).toBe(200);
    expect(items(a)).toHaveLength(1);
    expect(items(a)[0]?.id).toBe(RUN_A);
    expect(items(a)[0]?.rulesetVersionId).toBe(RULESET_VERSION);

    const b = await as(KC.b, 'GET', `/api/v1/revisions/${REVISION_B}/checks`);
    expect(items(b)).toHaveLength(1);
    // Сводка прогона отдаётся passthrough-объектом, поэтому маркер доходит до
    // владельца — и потому его отсутствие у чужого читателя что-то значит.
    expect(b.body).toContain(SECRET);
  });

  it('подрядчик А не получает прогонов ревизии Б', async () => {
    const list = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_B}/checks`);
    expect(list.statusCode).toBe(200);
    expect(items(list)).toEqual([]);
    expect(list.body).not.toContain(SECRET);

    // Положительный контроль рядом: свой список подрядчика А непуст.
    const own = await as(KC.a, 'GET', `/api/v1/revisions/${REVISION_A}/checks`);
    expect(items(own)).toHaveLength(1);
  });

  it('подрядчик Б не получает прогонов ревизии А — изоляция симметрична', async () => {
    const list = await as(KC.b, 'GET', `/api/v1/revisions/${REVISION_A}/checks`);
    expect(items(list)).toEqual([]);

    const own = await as(KC.b, 'GET', `/api/v1/revisions/${REVISION_B}/checks`);
    expect(items(own)).toHaveLength(1);
  });

  it('инженер без назначенных объектов не видит прогонов, инженер объекта — видит', async () => {
    const empty = await as(KC.engineerNoScope, 'GET', `/api/v1/revisions/${REVISION_A}/checks`);
    expect(empty.statusCode).toBe(200);
    expect(items(empty)).toEqual([]);

    const scoped = await as(KC.engineer, 'GET', `/api/v1/revisions/${REVISION_A}/checks`);
    expect(items(scoped)).toHaveLength(1);
  });
});

// =====================================================================
// GET /admin/rule-catalog — право `rules.publish`
// =====================================================================

describe('GET /api/v1/admin/rule-catalog', () => {
  it('администратор получает каталог целиком', async () => {
    const response = await as(KC.admin, 'GET', '/api/v1/admin/rule-catalog');
    expect(response.statusCode).toBe(200);
    const list = items(response);
    // Непустота утверждается отдельно: каталог, схлопнувшийся до нуля, прошёл
    // бы сравнение длин сам с собой.
    expect(list.length).toBeGreaterThan(0);
    expect(list).toHaveLength(RULE_CATALOG.length);
    expect(list.map((entry) => entry.code)).toContain(RULE_CODE);
    expect(list[0]).toHaveProperty('defaultSeverity');
    expect(list[0]).toHaveProperty('defaultParams');
  });

  it('роли без права `rules.publish` каталог не отдаётся', async () => {
    // Инженер и руководитель ведут проверки, но публикация набора правил —
    // административное действие (§3.7): право выдано только `admin`.
    for (const kcSub of [KC.engineer, KC.manager, KC.a]) {
      const response = await as(kcSub, 'GET', '/api/v1/admin/rule-catalog');
      expect(response.statusCode, `роль ${kcSub} не должна получать каталог`).toBe(403);
      expect(response.body).not.toContain(RULE_CODE);
    }
  });
});

// =====================================================================
// POST /revisions/{id}/checks — право, область и идемпотентность
// =====================================================================

describe('POST /api/v1/revisions/{id}/checks', () => {
  it('подрядчику запуск проверок запрещён и задача не ставится', async () => {
    const before = await totalCheckJobs();
    const response = await as(KC.a, 'POST', `/api/v1/revisions/${REVISION_A}/checks`, {
      body: {},
      idempotencyKey: 'contractor-attempt',
    });
    expect(response.statusCode).toBe(403);
    expect(await totalCheckJobs()).toBe(before);
  });

  it('инженер без назначенных объектов получает 404 и ничего не ставит в очередь', async () => {
    const before = await totalCheckJobs();
    const response = await as(
      KC.engineerNoScope,
      'POST',
      `/api/v1/revisions/${REVISION_B}/checks`,
      { body: {}, idempotencyKey: 'foreign-revision' },
    );
    // 404, а не 403: обработчик сам ищет ревизию через `findRevisionForFiles`
    // и не находит её в пустой области. Отвечать 403 значило бы подтверждать
    // существование чужой ревизии.
    expect(response.statusCode).toBe(404);
    expect(await jobsByKey(dedupeKey(REVISION_B, 'foreign-revision'))).toHaveLength(0);
    expect(await totalCheckJobs()).toBe(before);
  });

  it('первый запуск ставит РОВНО ОДНУ задачу checks.run с ревизией в payload', async () => {
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_A}/checks`, {
      body: {},
      idempotencyKey: 'run-1',
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ jobId: string | null; created: boolean }>();
    expect(body.created).toBe(true);
    expect(body.jobId).not.toBeNull();

    const rows = await jobsByKey(dedupeKey(REVISION_A, 'run-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(body.jobId);
    const payload = JSON.parse(rows[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload.revisionId).toBe(REVISION_A);
  });

  it('повтор с тем же Idempotency-Key даёт тот же jobId и НЕ заводит второй строки', async () => {
    const before = await totalCheckJobs();
    const first = await jobsByKey(dedupeKey(REVISION_A, 'run-1'));

    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_A}/checks`, {
      body: {},
      idempotencyKey: 'run-1',
    });
    // 202 отдаётся и здесь: наблюдаемое отличие повтора — только очередь.
    expect(response.statusCode).toBe(202);
    const body = response.json<{ jobId: string | null; created: boolean }>();
    expect(body.created).toBe(false);
    expect(body.jobId).toBe(first[0]?.id);

    expect(await jobsByKey(dedupeKey(REVISION_A, 'run-1'))).toHaveLength(1);
    expect(await totalCheckJobs()).toBe(before);
  });

  it('другой Idempotency-Key — осознанный повторный прогон, вторая задача', async () => {
    const before = await totalCheckJobs();
    const response = await as(KC.engineer, 'POST', `/api/v1/revisions/${REVISION_A}/checks`, {
      body: {},
      idempotencyKey: 'run-2',
    });
    expect(response.statusCode).toBe(202);
    expect(response.json<{ created: boolean }>().created).toBe(true);

    expect(await jobsByKey(dedupeKey(REVISION_A, 'run-2'))).toHaveLength(1);
    // Первая задача при этом на месте: новый ключ добавляет прогон, а не
    // подменяет уже стоящий.
    expect(await jobsByKey(dedupeKey(REVISION_A, 'run-1'))).toHaveLength(1);
    expect(await totalCheckJobs()).toBe(before + 1);
  });

  it('без заголовка ключ строится по ревизии, и повторы сливаются в одну задачу', async () => {
    const first = await as(KC.manager, 'POST', `/api/v1/revisions/${REVISION_B}/checks`, {
      body: {},
    });
    expect(first.statusCode).toBe(202);
    expect(first.json<{ created: boolean }>().created).toBe(true);

    const second = await as(KC.manager, 'POST', `/api/v1/revisions/${REVISION_B}/checks`, {
      body: {},
    });
    expect(second.json<{ created: boolean }>().created).toBe(false);

    expect(await jobsByKey(dedupeKey(REVISION_B, 'default'))).toHaveLength(1);
  });
});

// =====================================================================
// Подключение маршрутов (урок S3)
// =====================================================================

describe('регистрация маршрутов', () => {
  /**
   * Модуль, написанный и не подключённый, проходит собственные тесты и
   * недостижим снаружи. Поэтому список снимается с СОБРАННОГО приложения.
   */
  it('все маршруты модуля достижимы в собранном приложении', () => {
    const expected: readonly (readonly ['GET' | 'POST', string])[] = [
      ['POST', '/api/v1/revisions/:revisionId/checks'],
      ['GET', '/api/v1/revisions/:revisionId/checks'],
      ['GET', '/api/v1/revisions/:revisionId/findings'],
      ['GET', '/api/v1/revisions/:revisionId/check-report'],
      ['GET', '/api/v1/admin/rule-catalog'],
    ];
    for (const [method, url] of expected) {
      expect(app.hasRoute({ method, url }), `маршрут ${method} ${url} не зарегистрирован`).toBe(
        true,
      );
    }
  });

  it('проверка чувствительна: несуществующий маршрут модуля не находится', () => {
    // Без этого утверждения предыдущий тест проходил бы и при поломанном
    // способе проверки.
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/admin/rule-catalog' })).toBe(false);
  });
});

// =====================================================================
// Отчёт о составе комплекта (S29)
// =====================================================================

/**
 * Проверяется то, ради чего отчёт и появился: по экрану должно быть ВИДНО, что
 * портал прочитал, и в каком состоянии каждая позиция комплекта.
 *
 * Заказчик прошёл стенд и сказал: «результат распознавания невозможно понять».
 * Пустая таблица ошибок отвечала на вопрос «что не так» и молчала обо всём
 * остальном, поэтому здесь утверждается не отсутствие ошибок, а наличие состава
 * и честность каждой отметки — включая ту, которая говорит «не знаю».
 */
interface ReportItemBody {
  readonly code: string;
  readonly title: string;
  readonly status: string;
  readonly detail: string | null;
  readonly hint: string | null;
}

interface ReportRowBody {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly page: { number: number; workingPageIndex: number | null } | null;
  readonly pages: string | null;
  readonly dates: {
    issuedAt: string | null;
    validFrom: string | null;
    validTo: string | null;
  } | null;
  readonly status: string;
  readonly statusText: string;
  readonly statusHint: string | null;
  readonly findingIds: readonly string[];
  readonly items: readonly ReportItemBody[];
}

interface ReportBody {
  readonly runId: string | null;
  readonly sections: readonly {
    readonly kind: string;
    readonly title: string;
    readonly note: string | null;
    readonly rows: readonly ReportRowBody[];
  }[];
}

async function report(kcSub: string, revisionId: string): Promise<ReportBody> {
  const response = await as(kcSub, 'GET', `/api/v1/revisions/${revisionId}/check-report`);
  expect(response.statusCode).toBe(200);
  return response.json<ReportBody>();
}

function sectionOf(body: ReportBody, kind: string): ReportBody['sections'][number] {
  const found = body.sections.find((section) => section.kind === kind);
  if (found === undefined) throw new Error(`в отчёте нет секции ${kind}`);
  return found;
}

describe('GET /revisions/:id/check-report', () => {
  it('порядок секций задан заказчиком: акт, реестр, документы о качестве', async () => {
    const body = await report(KC.a, REVISION_D);
    // Пересортировка на клиенте либо повторила бы этот порядок, либо разошлась
    // бы с ним, поэтому его держит сервер.
    expect(body.sections.map((section) => section.kind)).toEqual([
      'act',
      'registry',
      'quality',
      'unplaced',
    ]);
    expect(body.runId).toBe(RUN_D);
  });

  it('акт идёт одной строкой с чек-листом, и галочка достаётся только пройденному', async () => {
    const act = sectionOf(await report(KC.a, REVISION_D), 'act');
    expect(act.rows).toHaveLength(1);

    const row = act.rows[0] as ReportRowBody;
    expect(row.title).toContain('01-Бл-П');
    expect(row.pages).toBe('1–2');
    expect(row.page?.number).toBe(1);

    const byCode = new Map(row.items.map((item) => [item.code, item]));
    // Пройденное правило — единственный случай, где ставится галочка.
    expect(byCode.get('AOSR.HDR.020')?.status).toBe('ok');
    expect(byCode.get('AOSR.HDR.021')?.status).toBe('error');
    expect(byCode.get('AOSR.HDR.021')?.detail).toContain('ИНН');
    // Троичность §0.5: «неприменимо» и «не исполнялось» не сливаются ни с
    // успехом, ни с ошибкой — иначе портал выдавал бы непроверенное за
    // проверенное.
    expect(byCode.get('AOSR.P3.070')?.status).toBe('not_applicable');
    expect(byCode.get('AOSR.P3.070')?.detail).toBe('профиль раздела не настроен');
    expect(byCode.get('AOSR.ACT.032')?.status).toBe('not_run');
    expect(byCode.get('AOSR.ACT.032')?.detail).toBe('правило не входит в профиль раздела');
  });

  it('способ устранения виден в строке, а не только в раскрытии', async () => {
    const findings = sectionOf(await report(KC.engineer, REVISION_A), 'quality');
    const cert = findings.rows[0] as ReportRowBody;
    // ADR-0016 назвал это отдельным решением: замечание без способа устранения
    // бесполезно подрядчику, а раскрытие — ещё одно нажатие ради двух строк.
    expect(cert.statusHint).toBe('Проверьте нумерацию актов.');
  });

  it('название пункта чек-листа берётся из набора правил, а не из кода', async () => {
    const act = sectionOf(await report(KC.a, REVISION_D), 'act');
    const item = (act.rows[0] as ReportRowBody).items.find(
      (candidate) => candidate.code === 'AOSR.HDR.020',
    );
    // Администратор переименовывает правила в портале, и каталог в коде
    // разошёлся бы с `rule_definitions` при первой же правке.
    expect(item?.title).toBe('Реквизиты сторон в шапке акта заполнены');
  });

  it('строки внутреннего реестра показывают наличие каждого названного документа', async () => {
    const registry = sectionOf(await report(KC.a, REVISION_D), 'registry');
    const rows = registry.rows;

    // Первой идёт сам документ-реестр, за ним — его строки по порядку.
    expect(rows[0]?.kind).toBe('document');
    expect(rows[1]?.kind).toBe('registry_row');

    const matched = rows.find((row) => row.id === REG_ROW_MATCHED);
    expect(matched?.status).toBe('ok');
    expect(matched?.statusText).toContain('стр. 4');
    expect(matched?.title).toBe('1. Документ о качестве');

    const missing = rows.find((row) => row.id === REG_ROW_MISSING);
    expect(missing?.status).toBe('error');
    expect(missing?.statusText).toBe('нет в комплекте');
  });

  it('у сертификата видны даты и замечание о сроке', async () => {
    const quality = sectionOf(await report(KC.a, REVISION_D), 'quality');
    const cert = quality.rows.find((row) => row.id === DOC_D_CERT);

    expect(cert?.dates).toEqual({
      issuedAt: '2023-03-12',
      validFrom: null,
      validTo: '2024-03-12',
    });
    expect(cert?.status).toBe('warning');
    expect(cert?.statusText).toContain('истёк');
    expect(cert?.findingIds).toEqual([FINDING_D_CERT]);
  });

  it('документ без замечаний подтверждается прямо, а не молчанием', async () => {
    const quality = sectionOf(await report(KC.a, REVISION_D), 'quality');
    const passport = quality.rows.find((row) => row.id === DOC_D_PASSPORT);
    expect(passport?.status).toBe('ok');
    expect(passport?.statusText).toBe('данные верны');
  });

  it('документы упорядочены по первой странице, а не по порядку в базе', async () => {
    const quality = sectionOf(await report(KC.a, REVISION_D), 'quality');
    // В фикстуре паспорт вставлен ПЕРВЫМ и имеет ordinal 0, но лежит на
    // последней странице: человек листает комплект, а не таблицу.
    expect(quality.rows.map((row) => row.id)).toEqual([DOC_D_CERT, DOC_D_PASSPORT]);
  });

  it('ни одно видимое замечание не теряется: чему не нашлось строки — в отдельной секции', async () => {
    const body = await report(KC.a, REVISION_D);
    const placed = new Set(
      body.sections.flatMap((section) => section.rows.flatMap((row) => row.findingIds)),
    );

    // Инвариант полноты: молча потерянное замечание хуже показанного дважды.
    expect(placed).toEqual(new Set([FINDING_D_ACT, FINDING_D_CERT, FINDING_D_MATERIAL]));

    const unplaced = sectionOf(body, 'unplaced');
    expect(unplaced.rows.flatMap((row) => row.findingIds)).toEqual([FINDING_D_MATERIAL]);
    expect(unplaced.note).toContain('не хватает');
  });

  it('БЕЗ прогона состав виден, но каждая строка честно говорит «не знаю»', async () => {
    const body = await report(KC.a, REVISION_E);
    expect(body.runId).toBeNull();

    const quality = sectionOf(body, 'quality');
    expect(quality.rows).toHaveLength(1);
    // Ровно то, чего не было на экране: комплект разобран, а проверка не
    // выполнялась — и портал это говорит вместо «Ошибок не найдено».
    expect(quality.rows[0]?.status).toBe('unchecked');
    expect(quality.rows[0]?.statusText).toBe('проверка по правилам не выполнялась');
  });

  it('без реестра приложений секция объясняет, почему сверять не с чем', async () => {
    const registry = sectionOf(await report(KC.a, REVISION_E), 'registry');
    expect(registry.rows).toHaveLength(0);
    expect(registry.note).toContain('не найден');
  });

  it('чужой комплект не отдаётся: ни состава, ни замечаний', async () => {
    const body = await report(KC.b, REVISION_D);
    // Положительный контроль стоит выше: владелец получает непустой отчёт, и
    // только поэтому пустота у соседа доказывает изоляцию, а не сломанный запрос.
    expect(body.sections).toHaveLength(0);
    expect(body.runId).toBeNull();
  });

  it('инженер без назначенных объектов не видит отчёт', async () => {
    const body = await report(KC.engineerNoScope, REVISION_D);
    expect(body.sections).toHaveLength(0);
  });
});
