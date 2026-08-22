-- Реестры и комплекты вместо томов и поставок; плоский справочник разделов (§3).
--
-- ## Что заставило переделать модель
--
-- Разбор настоящего реестра исполнительной документации показал, что прежняя
-- иерархия «объект → раздел объекта → том → поставка» описывает не тот процесс.
-- Реестр — это не папка и не контейнер, а СОПРОВОДИТЕЛЬНАЯ ОПИСЬ передаваемого
-- комплекта: нумерованный подписанный документ с шапкой (объект, участники,
-- корпус, этаж), с группами «работа (исполнитель)» и с подвалом «Передал /
-- Принял». Внутри одного реестра работы разных субподрядчиков; передаёт его
-- инженер ПТО генподрядчика, принимает технический заказчик.
--
-- Отсюда три вывода, каждый из которых виден в этой миграции.
--
-- **Том был пустым уровнем.** Он хранил код, наименование и `auto_run_enabled` и
-- существовал только чтобы сгруппировать поставки. Группировку задают раздел и
-- месяц, поэтому том исчезает, а `auto_run_enabled` переезжает на комплект — к
-- той единице, для которой он и осмыслен.
--
-- **Поставка стала комплектом работы.** Единица подачи — не «поставка вообще», а
-- работа с исполнителем: один АОСР со своими приложениями. Поэтому `submissions`
-- переименована в `works`, получила раздел, месяц и организацию, ведущую
-- комплект, и потеряла том. Ревизии остались на ней: `contractor_id` ревизии
-- закрыт составным внешним ключом на строку-владельца (§4.1, третий уровень
-- изоляции), а у реестра `contractor_id` нет по построению — в нём работы разных
-- организаций. Владельцем ревизии может быть только комплект.
--
-- **Раздел перестал принадлежать объекту.** Прежняя пара «вид раздела —
-- конфигурация» и «раздел объекта — коммерческие данные» существовала потому,
-- что раздел был копией на каждом объекте. Разделы взяты из сметного деления и
-- одинаковы для всех строек, поэтому копия не нужна: `sections` — плоский
-- глобальный справочник, `object_sections` — список включённых на объекте, а
-- `section_kinds` исчезает вместе с различием.
--
-- ## Чего эта миграция НЕ трогает
--
-- Всё, что живёт под ревизией: файлы, страницы, рабочий документ, разметку,
-- распознавание, логические документы, замечания, архив и удержания. Двадцать
-- триггеров `deny_locked_revision_content` и четыре триггера самой ревизии
-- (0008) ищут статус по `submission_revisions.id` и о родителе не знают вовсе —
-- поэтому смена родителя их не касается. Сама таблица `submission_revisions` не
-- переименована намеренно: переименование стоило бы правки пятнадцати
-- репозиториев и трёх функций-триггеров, не изменив ни одного инварианта.
--
-- ## Почему миграция начинается с предохранителя
--
-- Она удаляет таблицы, а не переносит из них данные: на момент выкладки портал
-- в эксплуатацию не введён и ИД в нём нет. Это допущение проверяется, а не
-- предполагается — `DROP TABLE volumes` на базе с поставками уничтожил бы
-- работу, и обнаружилось бы это после того, как транзакция закоммитилась.
--
-- ## Заголовок 0003 после этой миграции читается неверно
--
-- Первая строка `0003_submissions_and_files.sql` называет том и поставку. Файл
-- НЕ правится: раннер сверяет контрольные суммы применённых миграций, и правка
-- задним числом сделала бы уже применённую историю неприменимой. Смысл того
-- заголовка отменяет эта миграция; остальная его часть — про денормализацию
-- `object_id`/`contractor_id` и составные внешние ключи — остаётся в силе
-- дословно и относится теперь к `works`.

-- =====================================================================
-- 0. Предохранитель
-- =====================================================================

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM submissions) OR EXISTS (SELECT 1 FROM volumes) THEN
    RAISE EXCEPTION 'В базе есть поставки или тома: миграция 0028 рассчитана на пустую базу'
      USING HINT = 'Перенос данных этой миграцией не выполняется — он не проектировался';
  END IF;
END
$guard$;

-- =====================================================================
-- 1. Том исчезает
-- =====================================================================

-- Столбец уносит с собой и составной внешний ключ, и индекс по нему.
ALTER TABLE submissions DROP COLUMN volume_id;

DROP TABLE volumes;

-- =====================================================================
-- 2. Раздел объекта: копия справочника становится списком включённых
-- =====================================================================

-- Наложение правил ссылалось на раздел объекта его uuid. Со сменой ключа ссылка
-- становится кодом; столбец удаляется вместе со своими индексами и составным
-- ключом, а не переписывается.
ALTER TABLE object_rule_profiles DROP COLUMN section_id;

DROP TABLE object_sections;

-- Плоский справочник разделов работ. Один на портал: раздел «кровля» на всех
-- стройках один и тот же, и копия его на каждом объекте порождала бы ровно ту
-- рассинхронизацию, ради устранения которой справочники и заводят.
CREATE TABLE sections (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sections_code_chk CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT sections_sort_order_chk CHECK (sort_order >= 0)
);

-- Какие разделы включены на объекте. Строка есть — раздел на объекте ведётся;
-- строки нет — таких работ на нём не выполняется, и предлагать его в форме
-- заведения комплекта незачем.
--
-- Составной первичный ключ служит и целью внешних ключей комплекта и реестра:
-- «раздел, указанный вместе с объектом, обязан быть на этом объекте включён».
-- Тот же приём, которым прежняя схема связывала том с разделом.
CREATE TABLE object_sections (
  object_id    uuid NOT NULL REFERENCES construction_objects (id),
  section_code text NOT NULL REFERENCES sections (code),
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_id, section_code)
);

CREATE INDEX ix_object_sections_section ON object_sections (section_code);

-- =====================================================================
-- 3. Профиль раздела и наложения правил переезжают на код
-- =====================================================================

ALTER TABLE section_profiles RENAME COLUMN section_kind_code TO section_code;

ALTER TABLE section_profiles DROP CONSTRAINT section_profiles_section_kind_code_fkey;
ALTER TABLE section_profiles
  ADD CONSTRAINT section_profiles_section_code_fkey
  FOREIGN KEY (section_code) REFERENCES sections (code);

ALTER TABLE section_profiles
  RENAME CONSTRAINT section_profiles_kind_version_uq TO section_profiles_section_version_uq;

-- Индекс «не более одного открытого периода» пересоздаётся под новым столбцом:
-- переименование столбца его определение не переписывает.
DROP INDEX ux_section_profiles_open_period;
CREATE UNIQUE INDEX ux_section_profiles_open_period
  ON section_profiles (section_code)
  WHERE effective_to IS NULL AND published_at IS NOT NULL;

DROP TABLE section_kinds;

-- Наложение правил объекта: `section_code` пуст — наложение на весь объект.
ALTER TABLE object_rule_profiles ADD COLUMN section_code text;

ALTER TABLE object_rule_profiles
  ADD CONSTRAINT object_rule_profiles_section_fk
  FOREIGN KEY (object_id, section_code) REFERENCES object_sections (object_id, section_code);

-- Два частичных индекса вместо UNIQUE (object_id, section_code, version): NULL в
-- section_code (наложение всего объекта) обычным UNIQUE не сравнивается, и такие
-- строки дублировались бы. Причина та же, что была в 0002.
CREATE UNIQUE INDEX ux_object_rule_profiles_section_version
  ON object_rule_profiles (object_id, section_code, version)
  WHERE section_code IS NOT NULL;
CREATE UNIQUE INDEX ux_object_rule_profiles_object_version
  ON object_rule_profiles (object_id, version)
  WHERE section_code IS NULL;

CREATE INDEX ix_object_rule_profiles_section ON object_rule_profiles (section_code);

-- =====================================================================
-- 4. Закрепление подрядчиков за объектом
-- =====================================================================

-- Связи «подрядчик работает на этом объекте» в схеме не существовало вовсе:
-- единственным признаком закрепления была уже существующая поставка. Из-за
-- этого подрядчик, у которого на объекте ещё нет ни одной поставки, не видел ни
-- объекта, ни его томов и не мог завести первую — долг, названный вслух в
-- `navigation.ts` и показанный пользователю на экране тома. Здесь связь
-- заводится явно и становится целью составного внешнего ключа комплекта.
CREATE TABLE object_contractors (
  object_id     uuid NOT NULL REFERENCES construction_objects (id),
  contractor_id uuid NOT NULL REFERENCES counterparties (id),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (object_id, contractor_id)
);

CREATE INDEX ix_object_contractors_contractor ON object_contractors (contractor_id);

-- =====================================================================
-- 5. Реестр — нумерованный документ передачи
-- =====================================================================

-- Ключ реестра — НЕ «объект + раздел + месяц». Реестров за один месяц по одному
-- разделу бывает несколько (передали часть в середине месяца и остаток в конце),
-- и это разные подписанные бумаги с разными номерами. Ключ по месяцу заставил бы
-- слить их в одну запись, то есть потерять одну из подписей.
--
-- Номер обязателен к передаче, но не к заведению: черновик собирают заранее, а
-- номер присваивают, когда папку несут на подпись.
CREATE TABLE registries (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id               uuid NOT NULL REFERENCES construction_objects (id),
  section_code            text NOT NULL,
  -- Месяц, за который собран комплект. Хранится первым числом: месяц — это
  -- период, а не дата, и произвольный день внутри него сделал бы два реестра
  -- одного месяца неравными при сравнении.
  period                  date NOT NULL,
  number                  text,
  -- Реквизиты шапки реестра, как они напечатаны в бумаге.
  folder_no               text,
  building                text,
  floor                   text,
  structure               text,
  status                  text NOT NULL DEFAULT 'draft',
  -- Оптимистичная блокировка для If-Match: между «увидел состав» и «передал»
  -- проходят минуты, за которые второй сотрудник ПТО успевает изменить состав.
  version                 integer NOT NULL DEFAULT 0,
  issued_by               uuid REFERENCES users (id),
  issued_at               timestamptz,
  -- Ревизия комплекта-файла, поданная на момент передачи: по ней видно, КАКОЙ
  -- скан подписан, если файл потом заменяли.
  issued_file_revision_id uuid REFERENCES submission_revisions (id),
  accepted_by             uuid REFERENCES users (id),
  accepted_at             timestamptz,
  created_by              uuid NOT NULL REFERENCES users (id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registries_status_chk CHECK (status IN ('draft', 'issued', 'accepted')),
  CONSTRAINT registries_version_chk CHECK (version >= 0),
  CONSTRAINT registries_period_chk CHECK (EXTRACT(DAY FROM period) = 1),
  CONSTRAINT registries_number_required_chk CHECK (status = 'draft' OR number IS NOT NULL),
  -- Ключ для составного FK комплекта: реестр, указанный вместе с объектом,
  -- обязан принадлежать именно этому объекту.
  CONSTRAINT registries_object_id_uq UNIQUE (object_id, id),
  CONSTRAINT registries_section_fk
    FOREIGN KEY (object_id, section_code) REFERENCES object_sections (object_id, section_code)
);

-- Номер уникален в пределах объекта и только там, где он присвоен.
CREATE UNIQUE INDEX ux_registries_object_number
  ON registries (object_id, number) WHERE number IS NOT NULL;

CREATE INDEX ix_registries_object_status ON registries (object_id, status);
CREATE INDEX ix_registries_section ON registries (section_code);
CREATE INDEX ix_registries_issued_by ON registries (issued_by);
CREATE INDEX ix_registries_accepted_by ON registries (accepted_by);
CREATE INDEX ix_registries_created_by ON registries (created_by);
CREATE INDEX ix_registries_issued_file ON registries (issued_file_revision_id);

-- =====================================================================
-- 6. Поставка становится комплектом работы
-- =====================================================================

ALTER TABLE submissions RENAME TO works;

-- Номер поставки не переносится: нумеруется реестр, а не работа внутри него.
-- Порядковый номер работы в реестре — это `ordinal`, и он принадлежит реестру.
ALTER TABLE works DROP COLUMN number;

ALTER TABLE works
  -- Раздел и месяц: то, по чему комплект попадает в реестр. Заданы на комплекте,
  -- а не выводятся из реестра, потому что комплект существует ДО реестра —
  -- подрядчик грузит его, не зная, в какую папку он войдёт.
  ADD COLUMN section_code text NOT NULL,
  ADD COLUMN period date NOT NULL,
  -- Организация, ВЕДУЩАЯ комплект: сам исполнитель либо генподрядчик, если
  -- комплект заведён от его имени. Отделена от `contractor_id` (исполнителя)
  -- намеренно: состав правит только ведущая организация, а производное —
  -- разметку, распознавание, документы — любой с правом в области видимости.
  -- Это та же граница source/derived, которую держат триггеры 0008.
  ADD COLUMN managed_by_contractor_id uuid NOT NULL REFERENCES counterparties (id),
  -- Реестр, в который комплект включён. Пусто — комплект собран, но ещё не
  -- попал ни в одну папку; это нормальное состояние, а не незавершённость.
  ADD COLUMN registry_id uuid,
  -- `registry` — файл самого реестра: подписанный скан описи. Он проходит тот же
  -- конвейер из 23 задач, что и любой комплект, потому что всё в этом конвейере
  -- адресуется ревизией, а `source_files.revision_id` объявлен NOT NULL.
  -- Отдельная таблица под один файл означала бы второй конвейер.
  ADD COLUMN kind text NOT NULL DEFAULT 'complect',
  ADD COLUMN ordinal integer,
  -- Единственная настройка, при которой конвейер проходит остановки §6 без
  -- человека. Переехала с тома: на комплекте она осмысленна, на томе была
  -- свойством папки.
  ADD COLUMN auto_run_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE works
  ADD CONSTRAINT works_kind_chk CHECK (kind IN ('complect', 'registry')),
  ADD CONSTRAINT works_ordinal_chk CHECK (ordinal IS NULL OR ordinal > 0),
  ADD CONSTRAINT works_period_chk CHECK (EXTRACT(DAY FROM period) = 1),
  ADD CONSTRAINT works_registry_kind_chk CHECK (kind <> 'registry' OR registry_id IS NOT NULL),
  -- Раздел обязан быть включён на объекте, а подрядчик — закреплён за ним. Оба
  -- ограничения выражены ключом, а не проверкой в коде: маршрут, забывший
  -- проверить, не должен быть способом обойти закрепление.
  ADD CONSTRAINT works_section_fk
    FOREIGN KEY (object_id, section_code) REFERENCES object_sections (object_id, section_code),
  ADD CONSTRAINT works_contractor_fk
    FOREIGN KEY (object_id, contractor_id)
    REFERENCES object_contractors (object_id, contractor_id),
  ADD CONSTRAINT works_registry_fk
    FOREIGN KEY (object_id, registry_id) REFERENCES registries (object_id, id);

-- Имена ограничений — часть контракта миграций: по ним слой репозиториев
-- переводит отказ базы во внятный ответ. Оставить их с прежним именем значило бы
-- искать «submissions» в схеме, где такой таблицы больше нет.
ALTER TABLE works RENAME CONSTRAINT submissions_pkey TO works_pkey;
ALTER TABLE works RENAME CONSTRAINT submissions_scope_uq TO works_scope_uq;
ALTER TABLE works RENAME CONSTRAINT submissions_current_revision_fk TO works_current_revision_fk;
ALTER TABLE works RENAME CONSTRAINT submissions_object_id_fkey TO works_object_id_fkey;
ALTER TABLE works RENAME CONSTRAINT submissions_contractor_id_fkey TO works_contractor_id_fkey;
ALTER TABLE works RENAME CONSTRAINT submissions_created_by_fkey TO works_created_by_fkey;

ALTER INDEX ix_submissions_object RENAME TO ix_works_object;
ALTER INDEX ix_submissions_contractor RENAME TO ix_works_contractor;
ALTER INDEX ix_submissions_created_by RENAME TO ix_works_created_by;
ALTER INDEX ix_submissions_current_revision RENAME TO ix_works_current_revision;

-- Файл реестра у реестра один: второй означал бы две описи на одну папку, и
-- вопрос «какая из них подписана» не имел бы ответа.
CREATE UNIQUE INDEX ux_works_registry_file ON works (registry_id) WHERE kind = 'registry';
-- Порядок работ в реестре — тот же, что в бумаге; два комплекта под одним
-- номером сделали бы её невоспроизводимой.
CREATE UNIQUE INDEX ux_works_registry_ordinal
  ON works (registry_id, ordinal) WHERE ordinal IS NOT NULL;

CREATE INDEX ix_works_registry ON works (registry_id);
CREATE INDEX ix_works_managed_by ON works (managed_by_contractor_id);
CREATE INDEX ix_works_object_section_period ON works (object_id, section_code, period);

-- =====================================================================
-- 7. Ревизия переезжает с поставки на комплект
-- =====================================================================

ALTER TABLE submission_revisions RENAME COLUMN submission_id TO work_id;

ALTER TABLE submission_revisions
  RENAME CONSTRAINT submission_revisions_no_uq TO submission_revisions_work_no_uq;
ALTER TABLE submission_revisions
  RENAME CONSTRAINT submission_revisions_submission_id_uq TO submission_revisions_work_id_uq;

-- Частичный индекс «один незакрытый черновик» пересоздаётся: переименование
-- столбца его определение не переписывает.
DROP INDEX ux_submission_revisions_single_draft;
CREATE UNIQUE INDEX ux_submission_revisions_single_draft
  ON submission_revisions (work_id)
  WHERE status = 'draft';

-- =====================================================================
-- 8. Снимок состава при передаче
-- =====================================================================

-- Что именно передали — это факт, а не текущее состояние. Без снимка ответ на
-- вопрос «какой комплект подписан реестром №8» пересчитывался бы по ссылкам и
-- менялся бы при каждой новой ревизии комплекта: через месяц бумага и портал
-- рассказывали бы разное. Тот же принцип, по которому прогон проверок пиннит
-- версию набора правил и профиль раздела.
CREATE TABLE registry_items (
  registry_id   uuid NOT NULL REFERENCES registries (id),
  ordinal       integer NOT NULL,
  work_id       uuid NOT NULL,
  revision_id   uuid NOT NULL,
  -- Исполнитель и наименование работы копируются, а не читаются по ссылке:
  -- переименование работы не должно переписывать уже переданную опись.
  contractor_id uuid NOT NULL REFERENCES counterparties (id),
  title         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (registry_id, ordinal),
  CONSTRAINT registry_items_ordinal_chk CHECK (ordinal > 0),
  CONSTRAINT registry_items_work_uq UNIQUE (registry_id, work_id),
  -- Ревизия обязана принадлежать названному комплекту.
  CONSTRAINT registry_items_revision_fk
    FOREIGN KEY (work_id, revision_id) REFERENCES submission_revisions (work_id, id)
);

CREATE INDEX ix_registry_items_work ON registry_items (work_id);
CREATE INDEX ix_registry_items_contractor ON registry_items (contractor_id);

-- Состав запирается вместе с реестром: строки пишутся, пока он ещё черновик, и
-- становятся неизменяемыми в тот же миг, когда он передан. Охранник смотрит на
-- статус родителя — тем же приёмом, которым 0008 запирает содержимое ревизии.
CREATE TRIGGER registry_items_locked
  BEFORE INSERT OR UPDATE OR DELETE ON registry_items FOR EACH ROW
  EXECUTE FUNCTION deny_modification(
    'состав переданного реестра',
    '',
    'SELECT status <> ''draft'' FROM registries WHERE id = $1::uuid',
    'registry_id');

-- Переданный реестр неизменяем, кроме приёмки: подпись «Передал» стоит под
-- конкретной шапкой и конкретным номером.
CREATE TRIGGER registries_issued_immutable
  BEFORE UPDATE ON registries FOR EACH ROW
  WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION deny_modification(
    'переданный реестр',
    'status,version,updated_at,accepted_by,accepted_at');

CREATE TRIGGER registries_no_reopen
  BEFORE UPDATE ON registries FOR EACH ROW
  WHEN (OLD.status <> 'draft' AND NEW.status = 'draft')
  EXECUTE FUNCTION deny_modification('переданный реестр', '');

CREATE TRIGGER registries_no_delete
  BEFORE DELETE ON registries FOR EACH ROW
  WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION deny_modification('переданный реестр', '');

-- =====================================================================
-- 9. Роль генподрядчика
-- =====================================================================

-- Генподрядчик — не инженер заказчика и не подрядчик. Он собирает реестр из
-- комплектов разных исполнителей, грузит подписанный скан и передаёт папку; его
-- область видимости — объекты, где он назван генподрядчиком в карточке.
ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_chk;
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_role_chk
  CHECK (role IN ('contractor', 'general_contractor', 'engineer', 'manager', 'admin'));

ALTER TABLE rule_definitions DROP CONSTRAINT rule_definitions_waiver_roles_chk;
ALTER TABLE rule_definitions
  ADD CONSTRAINT rule_definitions_waiver_roles_chk CHECK (waiver_roles <@ ARRAY[
    'contractor', 'general_contractor', 'engineer', 'manager', 'admin']::text[]);
