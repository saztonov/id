/**
 * Данные для сквозного прогона Playwright.
 *
 * Фикстура — настоящие строки в настоящей схеме под настоящими миграциями, а не
 * подставные ответы. Это прямое требование задания: тест обязан ходить в
 * настоящее API. Мок вернул бы то, что в него положили, и не заметил бы ни
 * ошибки в пути, ни несовпадения формы ответа, ни отсутствия права — то есть
 * ровно те дефекты, которые ловились восемь этапов подряд.
 *
 * Три ревизии, каждая под свой сценарий:
 *
 * * `REVISION_EMPTY` — черновик без файлов: сценарий приёма файла целиком,
 *   от `init` до появления строки в списке;
 * * `REVISION_MARKUP` — черновик с настоящим PDF в хранилище, картой страниц и
 *   черновой разметкой: экран разметки, правка блоков, конфликт версий,
 *   заморозка и отправка на распознавание;
 * * `REVISION_REVIEW` — ревизия на проверке, готовая к согласованию: замечания
 *   и переход approve.
 */
import { createHash } from 'node:crypto';

/** Идентификаторы фиксированные: тест ссылается на них по имени. */
export function id(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export const IDS = {
  orgCustomer: id(1),
  orgContractor: id(2),
  object: id(4),
  section: id(5),
  volume: id(6),
  /** Закрытый том того же объекта: подать в него новую поставку нельзя. */
  volumeClosed: id(7),

  submissionEmpty: id(10),
  revisionEmpty: id(11),
  submissionMarkup: id(12),
  revisionMarkup: id(13),
  submissionReview: id(14),
  revisionReview: id(15),

  userContractor: id(20),
  userEngineer: id(21),
  userManager: id(22),
  userAdmin: id(23),
  /**
   * Роли `contractor` + `engineer` у одного человека.
   *
   * Право `submission.upload` у него есть — оно выдано роли подрядчика, — а
   * область видимости строится по СТАРШЕЙ роли и организации не содержит.
   * Создание поставки от такого пользователя отвергается, и портал обязан
   * сказать это до нажатия, а не показать непонятный отказ после.
   */
  userMixed: id(24),

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

  /** Профиль вида раздела: опубликованная версия и черновик поверх неё. */
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
};

export const KC = {
  contractor: 'kc-e2e-contractor',
  engineer: 'kc-e2e-engineer',
  manager: 'kc-e2e-manager',
  admin: 'kc-e2e-admin',
  mixed: 'kc-e2e-mixed',
};

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

/**
 * SQL фикстуры.
 *
 * `pdfSha` приходит извне: байты фикстуры кладутся в хранилище тем же кодом,
 * который считает их хэш, — иначе `GET /files/{id}/content` отдал бы 409 или
 * ушёл в хранилище за объектом, которого там нет, и экран разметки не показал бы
 * страницу. Такой промах выглядел бы как «pdf.js не работает».
 */
export function fixtureSql(pdfSha) {
  const workingSha = 'b'.repeat(64);
  const reviewSha = 'c'.repeat(64);
  const derivedSha = 'd'.repeat(64);

  return [
    `INSERT INTO counterparties (id, name, kind) VALUES ('${IDS.orgCustomer}', 'ООО «Застройщик»', 'customer')`,
    `INSERT INTO counterparties (id, name, kind) VALUES ('${IDS.orgContractor}', 'ООО «Подрядчик»', 'contractor')`,
    `INSERT INTO construction_objects (id, code, name, full_name, address)
       VALUES ('${IDS.object}', 'E2E01', 'Объект сквозного прогона', 'ЖК «Проверка», корпус 1', 'г. Москва')`,
    `INSERT INTO section_kinds (code, name) VALUES ('roofing', 'Кровля автостоянки')
       ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (id, object_id, code, name, section_kind_code)
       VALUES ('${IDS.section}', '${IDS.object}', '2.5.1', 'Кровля автостоянки', 'roofing')`,
    `INSERT INTO volumes (id, object_id, section_id, code, name)
       VALUES ('${IDS.volume}', '${IDS.object}', '${IDS.section}', 'V-1', 'Том 1')`,
    `INSERT INTO volumes (id, object_id, section_id, code, name, is_active)
       VALUES ('${IDS.volumeClosed}', '${IDS.object}', '${IDS.section}', 'V-2', 'Том 2. Закрытый', false)`,

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
       VALUES ('${IDS.userMixed}', '${KC.mixed}', 'Совмещающий роли', '${IDS.orgContractor}')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${IDS.userMixed}', 'contractor')`,
    `INSERT INTO user_roles (user_id, role) VALUES ('${IDS.userMixed}', 'engineer')`,
    `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${IDS.userMixed}', '${IDS.object}')`,
    `INSERT INTO user_object_scopes (user_id, object_id) VALUES ('${IDS.userEngineer}', '${IDS.object}')`,

    // --- Ревизия под сценарий приёма файла ---
    `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
       VALUES ('${IDS.submissionEmpty}', '${IDS.volume}', '${IDS.object}', '${IDS.orgContractor}',
               'Поставка без файлов', '${IDS.userContractor}')`,
    `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
       VALUES ('${IDS.revisionEmpty}', '${IDS.submissionEmpty}', '${IDS.object}', '${IDS.orgContractor}', 1, 'draft')`,

    // --- Ревизия под экран разметки ---
    `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
       VALUES ('${IDS.submissionMarkup}', '${IDS.volume}', '${IDS.object}', '${IDS.orgContractor}',
               'Поставка с разметкой', '${IDS.userContractor}')`,
    `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status)
       VALUES ('${IDS.revisionMarkup}', '${IDS.submissionMarkup}', '${IDS.object}', '${IDS.orgContractor}', 1, 'draft')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${pdfSha.sha}', '${blobKey(pdfSha.sha)}', ${pdfSha.size}, 'application/pdf')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${workingSha}', '${blobKey(workingSha)}', 4096, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${IDS.fileMarkup}', '${IDS.revisionMarkup}', '${pdfSha.sha}', 'Повороты.pdf', 0, 'ok')`,
    ...PAGES.map(
      (page) =>
        `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal,
                                   width_px, height_px, rotation, attention_flags)
           VALUES ('${page.id}', '${IDS.revisionMarkup}', '${IDS.fileMarkup}', ${page.index}, ${page.index},
                   ${page.width}, ${page.height}, ${page.rotation},
                   ${page.index === 2 ? `ARRAY['no_blocks','blank_page_candidate']::text[]` : `ARRAY[]::text[]`})`,
    ),
    `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${IDS.bundleMarkup}', '${IDS.revisionMarkup}', '${'e'.repeat(64)}', '${workingSha}', 'bundle/1+qpdf')`,
    ...PAGES.map(
      (page) =>
        `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
           VALUES ('${IDS.bundleMarkup}', '${IDS.revisionMarkup}', ${page.index}, '${page.id}')`,
    ),
    `INSERT INTO layout_revisions (id, revision_id, object_id, bundle_id, revision_no, state)
       VALUES ('${IDS.layoutMarkup}', '${IDS.revisionMarkup}', '${IDS.object}', '${IDS.bundleMarkup}', 1, 'draft')`,
    // RD-документ прогона: его создаёт задача 4 цепочки «Разметить файл», а
    // `startRecognitionRun` без него отвечает 409 «цепочка разметки не была
    // выполнена». Стенд поднимает портал без воркера и без RD WEB, поэтому
    // состояние «цепочка отработала» задаётся строкой — тем же, что записал бы
    // обработчик.
    `INSERT INTO rd_run_documents (layout_revision_id, rd_document_id, rd_project_id)
       VALUES ('${IDS.layoutMarkup}', 'rd-doc-e2e-1', 'rd-project-e2e')`,
    ...BLOCKS.map(
      (block) =>
        // `revision_id` и `bundle_id` денормализованы в самой таблице и объявлены
        // NOT NULL: без них блок мог сослаться на страницу чужой ревизии, и
        // составные FK ровно это и запрещают. Фикстура обязана их заполнять.
        `INSERT INTO layout_blocks (id, layout_revision_id, revision_id, bundle_id, source_page_id,
                                    working_page_index, object_id, block_type, shape_type,
                                    x0, y0, x1, y1, sort_order, source, detector_provenance)
           VALUES ('${block.id}', '${IDS.layoutMarkup}', '${IDS.revisionMarkup}', '${IDS.bundleMarkup}',
                   '${block.page}', ${block.workingPageIndex},
                   '${IDS.object}', '${block.type}', 'rectangle',
                   ${block.coords[0]}, ${block.coords[1]}, ${block.coords[2]}, ${block.coords[3]},
                   ${block.sortOrder}, 'auto', 'rf_detr')`,
    ),

    // --- Ревизия под согласование ---
    `INSERT INTO submissions (id, volume_id, object_id, contractor_id, title, created_by)
       VALUES ('${IDS.submissionReview}', '${IDS.volume}', '${IDS.object}', '${IDS.orgContractor}',
               'Поставка на проверке', '${IDS.userContractor}')`,
    // Ревизия создаётся ЧЕРНОВИКОМ и проводится по статусам ниже, после набивки
    // содержимого. Иначе триггер неизменяемости отвергает вставку файлов и
    // страниц: класс `source` заперт с момента подачи (§3.9, урок S2), и
    // фикстура, набивающая содержимое сразу в `in_review`, падает с 23001.
    `INSERT INTO submission_revisions (id, submission_id, object_id, contractor_id, revision_no, status,
                                       aggregate_manifest_hash)
       VALUES ('${IDS.revisionReview}', '${IDS.submissionReview}', '${IDS.object}', '${IDS.orgContractor}', 1,
               'draft', '${'f'.repeat(64)}')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${reviewSha}', '${blobKey(reviewSha)}', 2048, 'application/pdf')`,
    `INSERT INTO stored_blobs (sha256, s3_key, size_bytes, mime)
       VALUES ('${derivedSha}', '${blobKey(derivedSha)}', 1024, 'application/pdf')`,
    `INSERT INTO source_files (id, revision_id, blob_sha256, file_name, sort_order, verify_state)
       VALUES ('${IDS.fileReview}', '${IDS.revisionReview}', '${reviewSha}', 'АОСР.pdf', 0, 'ok')`,
    `INSERT INTO source_pages (id, revision_id, source_file_id, file_page_index, revision_ordinal,
                               width_px, height_px, rotation)
       VALUES ('${IDS.pageReview}', '${IDS.revisionReview}', '${IDS.fileReview}', 0, 0, 595, 842, 0)`,
    `INSERT INTO processing_bundles (id, revision_id, aggregate_manifest_hash, working_pdf_blob_sha256, builder_version)
       VALUES ('${IDS.bundleReview}', '${IDS.revisionReview}', '${'f'.repeat(64)}', '${reviewSha}', 'bundle/1+qpdf')`,
    `INSERT INTO processing_bundle_pages (bundle_id, revision_id, working_page_index, source_page_id)
       VALUES ('${IDS.bundleReview}', '${IDS.revisionReview}', 0, '${IDS.pageReview}')`,
    // Документ подтверждён И нарезан: оба условия approve (§9.6).
    // Провенанс нарезки заполняется ЦЕЛИКОМ: `logical_documents_derived_provenance_chk`
    // требует либо все шесть полей, либо ни одного — «половина значений означала бы
    // файл, о происхождении которого нечего сказать».
    `INSERT INTO logical_documents (id, revision_id, object_id, contractor_id, doc_type_code, ordinal, title,
                                    needs_review, is_confirmed, confirmed_by, confirmed_at,
                                    derived_pdf_blob_sha256, derived_pdf_page_count, derived_pdf_bytes,
                                    derived_pdf_built_at, derived_pdf_toolkit, derived_note_applied)
       VALUES ('${IDS.documentReview}', '${IDS.revisionReview}', '${IDS.object}', '${IDS.orgContractor}',
               'aosr', 1, 'АОСР № 336', false, true, '${IDS.userEngineer}', now(),
               '${derivedSha}', 1, 1024, now(), 'qpdf/11', true)`,
    `INSERT INTO page_assignments (revision_id, source_page_id, document_id, sort_order, needs_review)
       VALUES ('${IDS.revisionReview}', '${IDS.pageReview}', '${IDS.documentReview}', 0, false)`,
    `INSERT INTO ruleset_versions (id, version, published_at, published_by)
       VALUES ('${IDS.rulesetVersion}', '2026.08.1', now(), '${IDS.userAdmin}')`,
    // Указатель действующей версии — отдельная строка настроек, а не колонка
    // набора: «действующий» это состояние портала, а сам набор неизменяем.
    // Без этой строки прогон проверок сослался бы в пустоту, а экран правил
    // показал бы «действующая версия не назначена» — то есть стенд проверял бы
    // не боевое состояние.
    `INSERT INTO app_settings (key, value, updated_by)
       VALUES ('ruleset.active_version_id', to_jsonb('${IDS.rulesetVersion}'::text),
               '${IDS.userAdmin}')`,

    // --- Справочники §14, у которых на S11 появились экраны ---
    //
    // Профиль вида раздела: опубликованная версия отвечает на «действующий на
    // дату», черновик поверх неё — на «версию можно опубликовать отдельным
    // действием». Одной строки не хватило бы: два состояния различаются на
    // экране кнопкой, и проверять надо оба.
    `INSERT INTO section_profiles (id, section_kind_code, version, effective_from,
                                    expected_doc_types, material_categories, material_matrix,
                                    enabled_rule_codes, thresholds, autonomy_level,
                                    published_at, published_by)
       VALUES ('${IDS.sectionProfilePublished}', 'roofing', 1, DATE '2026-01-01',
               ARRAY['aosr']::text[], ARRAY['roll_waterproofing']::text[],
               '{"roll_waterproofing": {"passport": true}}'::jsonb,
               ARRAY['AOSR.HDR.022']::text[], '{"minCoverage": 0.6}'::jsonb, 'assisted',
               now(), '${IDS.userAdmin}')`,
    `INSERT INTO section_profiles (id, section_kind_code, version, effective_from,
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

    // Замечание с адресом БЛОКА на ревизии с разметкой: §16 называет переход
    // «finding → evidence» отдельным пунктом приёмки, а проверить его можно
    // только там, где разметка существует.
    `INSERT INTO validation_runs (id, revision_id, ruleset_version_id, started_at, finished_at, counts)
       VALUES ('${IDS.validationRunMarkup}', '${IDS.revisionMarkup}', '${IDS.rulesetVersion}',
               now(), now(), '{"rulesEvaluated": 4, "findings": 1}'::jsonb)`,
    `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                            severity, state, origin, is_blocking, target_type, target_id,
                            source_page_id, block_id, message, hint)
       VALUES ('${IDS.findingWithBlock}', '${IDS.validationRunMarkup}', '${IDS.revisionMarkup}',
               '${IDS.object}', '${IDS.orgContractor}', 'AOSR.HDR.022', 'warning', 'open',
               'deterministic', false, 'source_page', '${IDS.page1}',
               '${IDS.page1}', '${IDS.blockB}',
               'Штамп на странице не читается целиком', 'Проверьте рамку штампа на второй странице')`,
    // У `validation_runs` нет ни object_id, ни contractor_id: область видимости
    // прогона определяется его ревизией. Списывать состав колонок с §3 плана
    // нельзя — источник правды это миграция.
    `INSERT INTO validation_runs (id, revision_id, ruleset_version_id, started_at, finished_at, counts)
       VALUES ('${IDS.validationRun}', '${IDS.revisionReview}', '${IDS.rulesetVersion}',
               now(), now(), '{"rulesEvaluated": 12, "findings": 1}'::jsonb)`,
    // Замечание НЕ блокирующее: approve обязан пройти, а замечание — остаться
    // видимым. Блокирующее сделало бы сценарий согласования непроходимым, и это
    // проверяется отдельно — списком препятствий на экране.
    `INSERT INTO findings (id, validation_run_id, revision_id, object_id, contractor_id, rule_code,
                            severity, state, origin, is_blocking, target_type, target_id, source_page_id, message, hint)
       VALUES ('${IDS.findingWarning}', '${IDS.validationRun}', '${IDS.revisionReview}', '${IDS.object}',
               '${IDS.orgContractor}', 'AOSR.HDR.022', 'warning', 'open', 'deterministic', false,
               'document', '${IDS.documentReview}', '${IDS.pageReview}',
               'ОГРН не проходит проверку контрольной суммы', 'Сверьте значение с выпиской ЕГРЮЛ')`,

    // Проведение ревизии по статусам — последним шагом, когда содержимое уже
    // на месте. Ровно тот порядок, которым чинилась фикстура на S2.
    `UPDATE submission_revisions
        SET status = 'in_review', submitted_at = now(), submitted_by = '${IDS.userContractor}'
      WHERE id = '${IDS.revisionReview}'`,
  ];
}
