/**
 * Данные для сквозного прогона Playwright.
 *
 * Фикстура — настоящие строки в настоящей схеме под настоящими миграциями, а не
 * подставные ответы. Это прямое требование задания: тест обязан ходить в
 * настоящее API. Мок вернул бы то, что в него положили, и не заметил бы ни
 * ошибки в пути, ни несовпадения формы ответа, ни отсутствия права — то есть
 * ровно те дефекты, которые ловились восемь этапов подряд.
 *
 * Три ПАПКИ, каждая под свой сценарий:
 *
 * * `FOLDER_EMPTY` — папка без файлов: сценарий приёма файла целиком, от `init`
 *   до появления строки в списке, и «проверка ещё не выполнялась»;
 * * `FOLDER_MARKUP` — папка с настоящим PDF в хранилище, картой страниц и
 *   черновой разметкой: экран разметки, правка блоков, конфликт версий,
 *   тип страницы и отправка на распознавание;
 * * `FOLDER_REVIEW` — папка с разобранным документом и замечанием: экран
 *   проверки, отчёт, группировка по комплектам.
 *
 * ## Ревизий и реестров здесь больше нет
 *
 * До S44 фикстура сеяла `works` + `submission_revisions` + `registries`.
 * Миграции 0058 и 0059 сняли реестры и работы, схлопнули ревизию в саму папку и
 * ввели уровень `complects`. Порядок вставки при этом перестал что-либо значить:
 * двадцать один триггер `*_revision_locked`, из-за которого содержимое набивали
 * черновиком, а статус переводили последним шагом, снят вместе со статусом.
 * Класть строки можно в любом порядке, лишь бы соблюдались внешние ключи.
 */
import { createHash } from 'node:crypto';

import { folderTreeSql } from '@id/db-harness';

/** Идентификаторы фиксированные: тест ссылается на них по имени. */
export function id(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const IDS = {
  orgCustomer: id(1),
  orgContractor: id(2),
  object: id(4),
  /** Организация генподрядчика объекта: из неё выводится исполнитель папки. */
  orgGeneral: id(5),

  /**
   * Папки. Идентификаторы сохранены от прежних РЕВИЗИЙ, а не от работ: после
   * S44 рабочее место открывается по адресу `/ids/folders/{id}`, и спеки вместе
   * с `support/session.ts` ссылаются именно на эти UUID.
   */
  folderEmpty: id(11),
  folderMarkup: id(13),
  folderReview: id(15),

  userContractor: id(20),
  userEngineer: id(21),
  userManager: id(22),
  userAdmin: id(23),
  /**
   * Роли `contractor` + `engineer` у одного человека.
   *
   * Область видимости строится по СТАРШЕЙ роли и организации не содержит,
   * поэтому исполнителя портал выводит из карточки объекта и поднимает признак
   * «названо не человеком». Это и проверяется.
   */
  userMixed: id(24),
  /** Инженер ПТО генподрядчика: заводит папки за других. */
  userGeneral: id(25),

  fileMarkup: id(30),
  page0: id(40),
  page1: id(41),
  page2: id(42),
  page3: id(43),
  bundleMarkup: id(50),
  layoutMarkup: id(51),
  blockA: id(60),
  blockB: id(61),

  documentReview: id(70),
  validationRun: id(71),
  findingWarning: id(72),
  rulesetVersion: id(73),
  fileReview: id(74),
  pageReview: id(75),
  bundleReview: id(76),

  /** Профиль раздела: опубликованная версия и черновик поверх неё. */
  sectionProfilePublished: id(80),
  sectionProfileDraft: id(81),
  /** Шифр рабочей документации объекта. */
  rdDocument: id(82),
  /** Промт: опубликованная версия и её архивный предшественник (откат). */
  promptPublished: id(83),
  promptArchived: id(84),
  /** Замечание с адресом блока: навигация «finding → evidence» (§16). */
  validationRunMarkup: id(85),
  findingWithBlock: id(86),
  /** Комплект папки на проверке: отчёт группируется по комплектам (S44). */
  complectReview: id(90),
};

/** Проблемы журнала ошибок (§11): экрану нужны данные, а вызвать 500 из теста нечем. */
export const JOURNAL = {
  issueOpen: id(910),
  issueResolved: id(911),
};

export const KC = {
  contractor: 'kc-e2e-contractor',
  general: 'kc-e2e-general',
  engineer: 'kc-e2e-engineer',
  manager: 'kc-e2e-manager',
  admin: 'kc-e2e-admin',
  mixed: 'kc-e2e-mixed',
};

/**
 * Адреса тех же людей для прогона в режиме `local`.
 *
 * Отдельная таблица, а не производные от `KC`: в локальном режиме вход идёт по
 * адресу почты, а `kc_sub` там служебный. Пароль один на всех — стенд одноразовый
 * и живёт в памяти процесса.
 */
export const LOCAL_LOGINS = {
  contractor: 'contractor@e2e.example',
  general: 'general@e2e.example',
  engineer: 'engineer@e2e.example',
  manager: 'manager@e2e.example',
  admin: 'admin@e2e.example',
  mixed: 'mixed@e2e.example',
};

export const LOCAL_PASSWORD = 'Mostovoy-Kran-77!';

/**
 * Страницы фикстуры `rotated.pdf`: 0°, 90°, 180°, 270° и A3 landscape.
 *
 * Взято именно этот файл, потому что гейт §17 требует проверить пересчёт
 * координат при `rotation != 0`. Размеры записаны ПОСТ-поворотными — так их
 * пишет `apps/api/src/pdf/probe.ts`, и именно на этом держится совпадение
 * фреймов с вьюпортом pdf.js.
 */
export const PAGES = [
  { id: IDS.page0, index: 0, width: 595, height: 842, rotation: 0 },
  { id: IDS.page1, index: 1, width: 842, height: 595, rotation: 90 },
  { id: IDS.page2, index: 2, width: 595, height: 842, rotation: 180 },
  { id: IDS.page3, index: 3, width: 842, height: 1191, rotation: 270 },
];

/** Блоки черновой разметки: по одному на первых двух страницах. */
export const BLOCKS = [
  {
    id: IDS.blockA,
    page: IDS.page0,
    workingPageIndex: 0,
    type: 'text',
    coords: [0.08, 0.06, 0.92, 0.28],
    sortOrder: 0,
  },
  {
    id: IDS.blockB,
    page: IDS.page1,
    workingPageIndex: 1,
    type: 'stamp',
    coords: [0.6, 0.7, 0.95, 0.95],
    sortOrder: 0,
  },
];

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function blobKey(sha) {
  return `blobs/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;
}

/** Месяц папок стенда: один на все три, спеки печатают его в `IDS.period`. */
const PERIOD = '2026-01-01';

/**
 * SQL фикстуры.
 *
 * `sha`/`size` приходят извне: байты фикстуры кладутся в хранилище тем же кодом,
 * который считает их хэш, — иначе `GET /files/{id}/content` отдал бы 409 или
 * ушёл в хранилище за объектом, которого там нет, и экран разметки не показал бы
 * страницу. Такой промах выглядел бы как «pdf.js не работает».
 *
 * `aggregateHash` — каноническая форма хэша состава файлов, тоже снаружи: её
 * считает портал (`computeAggregateManifestHash`), и вторая реализация здесь
 * разошлась бы с первой на первой же правке. Передача аргументом вместо импорта
 * из `apps/api/dist` оставляет посев проверяемым без сборки (`fixture.test.mjs`).
 */
export function fixtureSql({ sha, size, aggregateHash }) {
  const workingSha = 'b'.repeat(64);
  const reviewSha = 'c'.repeat(64);
  const derivedSha = 'd'.repeat(64);

  /**
   * Папка заводится общим помощником `@id/db-harness`, а не выписанным здесь
   * `INSERT`: он же ставит раздел объекта (без `object_sections` падает
   * `folders_section_fk`) и связь объекта с организацией. Тридцать пять
   * скопированных вручную фикстур в тестах API однажды разошлись именно так, и
   * ровно так же на S44 разошёлся этот файл — переименование колонки папки
   * теперь правится в одном месте на весь монорепозиторий.
   */
  const folder = (folderId, title, contractorId, createdBy) =>
    folderTreeSql({
      folderId,
      objectId: IDS.object,
      contractorId,
      managedByContractorId: contractorId,
      userId: createdBy,
      sectionCode: 'roofing',
      sectionName: 'Кровля',
      period: PERIOD,
      folderTitle: title,
    });

  return [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${IDS.orgCustomer}', 'ООО «Застройщик»', 'customer')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${IDS.orgContractor}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${IDS.orgGeneral}', 'ООО «Генподрядчик»', 'general_contractor')`,
    // Область генподрядчика выводится из карточки объекта, а не назначается.
    `INSERT INTO construction_objects (id, code, name, full_name, address, general_contractor_id)
       VALUES ('${IDS.object}', 'E2E01', 'Объект сквозного прогона', 'ЖК «Проверка», корпус 1', 'г. Москва',
               '${IDS.orgGeneral}')`,
    // Связь объекта с генподрядчиком: папки его организации помощник свяжет сам,
    // но ни одной такой папки в фикстуре нет — заводит их сценарий.
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${IDS.object}', '${IDS.orgGeneral}') ON CONFLICT DO NOTHING`,

    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${IDS.userContractor}', '${KC.contractor}', 'Сотрудник подрядчика', '${IDS.orgContractor}')`,
    `INSERT INTO users (id, kc_sub, full_name)
       VALUES ('${IDS.userEngineer}', '${KC.engineer}', 'Инженер отдела ИД')`,
    `INSERT INTO users (id, kc_sub, full_name)
       VALUES ('${IDS.userManager}', '${KC.manager}', 'Руководитель отдела ИД')`,
    `INSERT INTO users (id, kc_sub, full_name)
       VALUES ('${IDS.userAdmin}', '${KC.admin}', 'Администратор портала')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${IDS.userContractor}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${IDS.userEngineer}', 'engineer')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${IDS.userManager}', 'manager')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${IDS.userAdmin}', 'admin')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${IDS.userGeneral}', '${KC.general}', 'Инженер ПТО генподрядчика', '${IDS.orgGeneral}')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${IDS.userGeneral}', 'general_contractor')`,
    `INSERT INTO users (id, kc_sub, full_name, contractor_id)
       VALUES ('${IDS.userMixed}', '${KC.mixed}', 'Совмещающий роли', '${IDS.orgContractor}')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${IDS.userMixed}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${IDS.userMixed}', 'engineer')`,
    `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${IDS.userMixed}', '${IDS.object}')`,
    `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${IDS.userEngineer}', '${IDS.object}')`,

    // --- Папка под сценарий приёма файла: ни файлов, ни рабочего документа ---
    ...folder(IDS.folderEmpty, 'Комплект без файлов', IDS.orgContractor, IDS.userContractor),

    // --- Папка под экран разметки ---
    ...folder(IDS.folderMarkup, 'Комплект с разметкой', IDS.orgContractor, IDS.userContractor),
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${sha}', '${blobKey(sha)}', ${size}, 'application/pdf')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${workingSha}', '${blobKey(workingSha)}', 4096, 'application/pdf')`,
    `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${IDS.fileMarkup}', '${IDS.folderMarkup}', '${sha}', 'Повороты.pdf', 0, 'ok')`,
    ...PAGES.map(
      (page) =>
        `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal,
                                   width_px, height_px, rotation, attention_flags)
           VALUES ('${page.id}', '${IDS.folderMarkup}', '${IDS.fileMarkup}', ${page.index}, ${page.index},
                   ${page.width}, ${page.height}, ${page.rotation},
                   ${page.index === 2 ? `ARRAY['no_blocks','blank_page_candidate']::text[]` : `ARRAY[]::text[]`})`,
    ),
    `INSERT INTO processing_bundles (id, folder_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${IDS.bundleMarkup}', '${IDS.folderMarkup}',
               '${aggregateHash([{ blobSha256: sha, sortOrder: 0 }])}',
               '${workingSha}', 'bundle/1+qpdf')`,
    ...PAGES.map(
      (page) =>
        `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
           VALUES ('${IDS.bundleMarkup}', '${IDS.folderMarkup}', ${page.index}, '${page.id}')`,
    ),
    `INSERT INTO layout_revisions (id, folder_id, object_id, bundle_id, revision_no, state)
       VALUES ('${IDS.layoutMarkup}', '${IDS.folderMarkup}', '${IDS.object}', '${IDS.bundleMarkup}', 1, 'draft')`,
    // RD-документ прогона: его создаёт задача 4 цепочки «Разметить файл», а
    // `startRecognitionRun` без него отвечает 409 «цепочка разметки не была
    // выполнена». Стенд поднимает портал без воркера и без RD WEB, поэтому
    // состояние «цепочка отработала» задаётся строкой — тем же, что записал бы
    // обработчик.
    `INSERT INTO rd_run_documents (layout_revision_id, rd_document_id, rd_project_id)
       VALUES ('${IDS.layoutMarkup}', 'rd-doc-e2e-1', 'rd-project-e2e')`,
    ...BLOCKS.map(
      (block) =>
        // `folder_id` и `bundle_id` денормализованы в самой таблице и объявлены
        // NOT NULL: без них блок мог сослаться на страницу чужой папки, и
        // составные FK ровно это и запрещают. Фикстура обязана их заполнять.
        `INSERT INTO layout_blocks (id, layout_revision_id, folder_id, bundle_id, source_page_id,
                                    working_page_index, object_id, block_type, shape_type,
                                    x0, y0, x1, y1, sort_order, source, detector_provenance)
           VALUES ('${block.id}', '${IDS.layoutMarkup}', '${IDS.folderMarkup}', '${IDS.bundleMarkup}',
                   '${block.page}', ${block.workingPageIndex},
                   '${IDS.object}', '${block.type}', 'rectangle',
                   ${block.coords[0]}, ${block.coords[1]}, ${block.coords[2]}, ${block.coords[3]},
                   ${block.sortOrder}, 'auto', 'rf_detr')`,
    ),

    // --- Папка под экран проверки ---
    ...folder(IDS.folderReview, 'Комплект на проверке', IDS.orgContractor, IDS.userContractor),
    // Хэш состава у папки намеренно НЕ совпадает с хэшем её рабочего документа:
    // экран проверки обязан уметь сказать «комплект изменился после проверки», и
    // проверять это надо там, где расхождение есть.
    `UPDATE folders SET aggregate_manifest_hash = '${'f'.repeat(64)}'
      WHERE id = '${IDS.folderReview}'`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${reviewSha}', '${blobKey(reviewSha)}', 2048, 'application/pdf')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${derivedSha}', '${blobKey(derivedSha)}', 1024, 'application/pdf')`,
    `INSERT INTO source_files (id, folder_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${IDS.fileReview}', '${IDS.folderReview}', '${reviewSha}', 'АОСР.pdf', 0, 'ok')`,
    `INSERT INTO source_pages (id, folder_id, source_file_id, file_page_index, folder_ordinal,
                               width_px, height_px, rotation)
       VALUES ('${IDS.pageReview}', '${IDS.folderReview}', '${IDS.fileReview}', 0, 0, 595, 842, 0)`,
    `INSERT INTO processing_bundles (id, folder_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${IDS.bundleReview}', '${IDS.folderReview}',
               '${aggregateHash([{ blobSha256: reviewSha, sortOrder: 0 }])}',
               '${reviewSha}', 'bundle/1+qpdf')`,
    `INSERT INTO processing_bundle_pages (bundle_id, folder_id, working_page_index, source_page_id)
       VALUES ('${IDS.bundleReview}', '${IDS.folderReview}', 0, '${IDS.pageReview}')`,
    // Комплект: папка режется конвейером на акты, и отчёт проверки с S44
    // группируется по ним, а не складывает двенадцать актов в одну таблицу.
    // Реквизиты акта заполнены — заголовок группы строит `titleOfComplect`, и без
    // них он назвал бы комплект порядковым номером.
    `INSERT INTO complects (id, folder_id, object_id, contractor_id, ordinal, act_number, act_date)
       VALUES ('${IDS.complectReview}', '${IDS.folderReview}', '${IDS.object}', '${IDS.orgContractor}',
               1, '336', DATE '2026-01-12')`,
    // Документ подтверждён И нарезан. Провенанс нарезки заполняется ЦЕЛИКОМ:
    // `logical_documents_derived_provenance_chk` требует либо все шесть полей,
    // либо ни одного — «половина значений означала бы файл, о происхождении
    // которого нечего сказать».
    `INSERT INTO logical_documents (id, folder_id, object_id, contractor_id, doc_type_code, ordinal, title,
                                    complect_id, needs_review, is_confirmed, confirmed_by, confirmed_at,
                                    derived_pdf_blob_sha256, derived_pdf_page_count, derived_pdf_bytes,
                                    derived_pdf_built_at, derived_pdf_toolkit, derived_note_applied)
       VALUES ('${IDS.documentReview}', '${IDS.folderReview}', '${IDS.object}', '${IDS.orgContractor}',
               'aosr', 1, 'АОСР № 336', '${IDS.complectReview}', false, true, '${IDS.userEngineer}', now(),
               '${derivedSha}', 1, 1024, now(), 'qpdf/11', true)`,
    `INSERT INTO page_assignments (folder_id, source_page_id, document_id, sort_order, needs_review)
       VALUES ('${IDS.folderReview}', '${IDS.pageReview}', '${IDS.documentReview}', 0, false)`,
    `INSERT INTO ruleset_versions (id, version, published_at, published_by)
       VALUES ('${IDS.rulesetVersion}', '2026.08.1', now(), '${IDS.userAdmin}')`,
    // Указатель действующей версии — отдельная строка настроек, а не колонка
    // набора: «действующий» это состояние портала, а сам набор неизменяем.
    // Без этой строки прогон проверок сослался бы в пустоту, а экран правил
    // показал бы «действующая версия не назначена» — то есть стенд проверял бы
    // не боевое состояние.
    // `ON CONFLICT`, потому что миграция 0044 заводит встроенный набор правил и
    // назначает действующим ЕГО. Стенду нужен свой: сценарии проверок ссылаются на
    // `IDS.rulesetVersion`. Без перезаписи вставка падает дубликатом ключа, и стенд
    // не поднимается вовсе.
    `INSERT INTO app_settings (key, value, updated_by)
       VALUES ('ruleset.active_version_id', to_jsonb('${IDS.rulesetVersion}'::text),
               '${IDS.userAdmin}')
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,

    // --- Справочники §14, у которых на S11 появились экраны ---
    //
    // Профиль раздела: опубликованная версия отвечает на «действующий на
    // дату», черновик поверх неё — на «версию можно опубликовать отдельным
    // действием». Одной строки не хватило бы: два состояния различаются на
    // экране кнопкой, и проверять надо оба.
    `INSERT INTO section_profiles (id, section_code, version, effective_from,
                                    expected_doc_types, material_categories, material_matrix,
                                    enabled_rule_codes, thresholds, autonomy_level,
                                    published_at, published_by)
       VALUES ('${IDS.sectionProfilePublished}', 'roofing', 1, DATE '2026-01-01',
               ARRAY['aosr']::text[], ARRAY['roll_waterproofing']::text[],
               '{"roll_waterproofing": {"passport": true}}'::jsonb,
               ARRAY['AOSR.HDR.022']::text[], '{"minCoverage": 0.6}'::jsonb, 'assisted',
               now(), '${IDS.userAdmin}')`,
    `INSERT INTO section_profiles (id, section_code, version, effective_from,
                                    expected_doc_types, autonomy_level)
       VALUES ('${IDS.sectionProfileDraft}', 'roofing', 2, DATE '2027-01-01',
               ARRAY['aosr']::text[], 'assisted')`,
    `INSERT INTO rd_documents (id, object_id, cipher, revision, name, designer_id)
       VALUES ('${IDS.rdDocument}', '${IDS.object}', 'АР-2.1-КР', '2',
               'Кровля. Узлы примыканий', '${IDS.orgCustomer}')`,

    // Промты: действующая версия и её архивный предшественник. Пара нужна
    // ровно ради отката — перехода `archived → published`, который у промта и
    // есть механизм возврата прежнего текста в эксплуатацию (§10).
    `INSERT INTO prompt_templates (id, code, version, stage, state, system_prompt, user_template,
                                    published_at, published_by)
       VALUES ('${IDS.promptArchived}', 'page_classify_base', 1, 'page_classify', 'archived',
               'Ты классифицируешь страницу комплекта.', 'Текст страницы: {{text}}',
               now(), '${IDS.userAdmin}')`,
    `INSERT INTO prompt_templates (id, code, version, stage, state, system_prompt, user_template,
                                    published_at, published_by)
       VALUES ('${IDS.promptPublished}', 'page_classify_base', 2, 'page_classify', 'published',
               'Ты классифицируешь страницу комплекта и не делаешь предположений о разделе работ.',
               'Текст страницы: {{text}}', now(), '${IDS.userAdmin}')`,

    // Замечание с адресом БЛОКА на папке с разметкой: §16 называет переход
    // «finding → evidence» отдельным пунктом приёмки, а проверить его можно
    // только там, где разметка существует.
    `INSERT INTO validation_runs (id, folder_id, ruleset_version_id, started_at, finished_at, counts)
       VALUES ('${IDS.validationRunMarkup}', '${IDS.folderMarkup}', '${IDS.rulesetVersion}',
               now(), now(), '{"rulesEvaluated": 4, "findings": 1}'::jsonb)`,
    `INSERT INTO findings (id, validation_run_id, folder_id, object_id, contractor_id, rule_code,
                            severity, state, origin, is_blocking, target_type, target_id,
                            source_page_id, block_id, message, hint)
       VALUES ('${IDS.findingWithBlock}', '${IDS.validationRunMarkup}', '${IDS.folderMarkup}',
               '${IDS.object}', '${IDS.orgContractor}', 'AOSR.HDR.022', 'warning', 'open',
               'deterministic', false, 'source_page', '${IDS.page1}',
               '${IDS.page1}', '${IDS.blockB}',
               'Штамп на странице не читается целиком', 'Проверьте рамку штампа на второй странице')`,
    // У `validation_runs` нет ни object_id, ни contractor_id: область видимости
    // прогона определяется его папкой. Списывать состав колонок с §3 плана
    // нельзя — источник правды это миграция.
    `INSERT INTO validation_runs (id, folder_id, ruleset_version_id, started_at, finished_at, counts)
       VALUES ('${IDS.validationRun}', '${IDS.folderReview}', '${IDS.rulesetVersion}',
               now(), now(), '{"rulesEvaluated": 12, "findings": 1}'::jsonb)`,
    // Замечание НЕ блокирующее: оно обязано остаться видимым и не закрыть собой
    // работу с папкой. Блокирующее проверяется отдельно — списком препятствий.
    `INSERT INTO findings (id, validation_run_id, folder_id, object_id, contractor_id, rule_code,
                            severity, state, origin, is_blocking, target_type, target_id, source_page_id,
                            complect_id, message, hint)
       VALUES ('${IDS.findingWarning}', '${IDS.validationRun}', '${IDS.folderReview}', '${IDS.object}',
               '${IDS.orgContractor}', 'AOSR.HDR.022', 'warning', 'open', 'deterministic', false,
               'document', '${IDS.documentReview}', '${IDS.pageReview}', '${IDS.complectReview}',
               'ОГРН не проходит проверку контрольной суммы', 'Сверьте значение с выпиской ЕГРЮЛ')`,

    // Журнал ошибок. Данные ставятся прямым SQL, потому что вызвать настоящую
    // 500 из браузерного теста нечем: любой сценарий, который её порождает, —
    // это дефект портала, и держать такой специально ради фикстуры нельзя.
    // Числа выбраны расходящимися намеренно: 42 события против одного примера,
    // чтобы подмена одной величины другой была видна на экране.
    `INSERT INTO error_issues (id, title, status, source, execution, domain, severity,
                               first_seen_at, last_seen_at, last_release)
       VALUES ('${JOURNAL.issueOpen}', 'Error: пул соединений исчерпан', 'new', 'api', 'http',
               'db', 'error', now() - interval '4 hours', now() - interval '2 minutes', '2026.08.1')`,
    `INSERT INTO error_issues (id, title, status, source, execution, domain, severity,
                               first_seen_at, last_seen_at, resolved_at, resolved_by,
                               root_cause, resolution, resolution_type)
       VALUES ('${JOURNAL.issueResolved}', 'LlmTimeoutError: модель не ответила', 'resolved',
               'worker', 'job', 'llm', 'error', now() - interval '9 days',
               now() - interval '8 days', now() - interval '7 days', '${IDS.userAdmin}',
               'таймаут шлюза был меньше времени ответа модели', 'поднят PROXY_LLM_TIMEOUT_MS',
               'fixed')`,
    `INSERT INTO error_signatures (fingerprint, algo_version, issue_id, error_class,
                                   message_template, top_frame, source)
       VALUES ('e2e0000000000001', 1, '${JOURNAL.issueOpen}', 'Error', 'пул соединений исчерпан',
               'claimJobs (apps/api/src/db/repositories/jobs.ts)', 'api')`,
    `INSERT INTO error_stats_hourly (issue_id, bucket_at, release, source, execution, domain,
                                     pipeline_stage, severity, count)
       VALUES ('${JOURNAL.issueOpen}', date_trunc('hour', now()), '2026.08.1', 'api', 'http',
               'db', 'none', 'error', 42)`,
    `INSERT INTO error_samples (issue_id, fingerprint, at, source, execution, domain, severity,
                                release, request_id, route, status_code, error_code)
       VALUES ('${JOURNAL.issueOpen}', 'e2e0000000000001', now() - interval '2 minutes', 'api',
               'http', 'db', 'error', '2026.08.1', 'req-e2e-000000000001',
               '/api/v1/folders', 500, '53300')`,
  ];
}
