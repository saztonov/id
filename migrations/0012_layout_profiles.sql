-- Версионный профиль разметки и пины ревизии разметки (§7.3, §6.1).
--
-- Пороги флагов внимания принадлежат профилю, а не коду. Константа в коде
-- означала бы, что калибровка порога на пилоте — это релиз, а прошлый расчёт
-- флагов невоспроизводим: по какому порогу страница 47 получила «низкое
-- покрытие», выяснить было бы нечем. Профиль версионный и с периодом действия
-- ровно по той же причине, по которой версионны профили разделов (§3.2), и
-- ревизия разметки пиннит тот, по которому её флаги посчитаны, — этот урок S4
-- (миграция 0011) повторять не нужно.

CREATE TABLE layout_profiles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,
  version        integer NOT NULL,
  effective_from date NOT NULL,
  effective_to   date,
  -- Пороги: единственное содержимое профиля. Форму проверяет приложение
  -- (jsonb_matches_schema() в PostgreSQL не существует, §0.1), поэтому здесь
  -- только «объект, а не скаляр».
  thresholds     jsonb NOT NULL,
  notes          text,
  published_at   timestamptz NOT NULL DEFAULT now(),
  published_by   uuid REFERENCES users (id),
  CONSTRAINT layout_profiles_code_chk CHECK (code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT layout_profiles_version_chk CHECK (version > 0),
  CONSTRAINT layout_profiles_thresholds_chk CHECK (jsonb_typeof(thresholds) = 'object'),
  CONSTRAINT layout_profiles_period_chk
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT layout_profiles_code_version_uq UNIQUE (code, version)
);

-- Открытый период у кода ровно один: два открытых периода означали бы, что
-- «действующий профиль» выбирается порядком строк. Ровно эта ошибка была
-- найдена в профилях разделов на S4.
CREATE UNIQUE INDEX ux_layout_profiles_open ON layout_profiles (code)
  WHERE effective_to IS NULL;

CREATE INDEX ix_layout_profiles_published_by ON layout_profiles (published_by);

-- Профиль по умолчанию. Значения — стартовые гипотезы, подлежащие калибровке на
-- пилоте (§7.3 прямо запрещает выдавать их за обещание), поэтому они и лежат
-- строкой в таблице, а не константами.
INSERT INTO layout_profiles (code, version, effective_from, thresholds, notes)
VALUES (
  'default',
  1,
  DATE '2020-01-01',
  '{
     "minCoverageRatio": 0.12,
     "blankPageCoverageRatio": 0.02,
     "tinyBlockAreaRatio": 0.002,
     "overlapIouThreshold": 0.2,
     "degenerateSideRatio": 0.002,
     "neighborCountDeltaRatio": 0.6,
     "neighborMinBlocks": 3,
     "expectStampOnImagePage": false
   }'::jsonb,
  'Стартовые пороги S6: измеряются на пилоте, «3–7 страниц из 83» не обещаны'
)
ON CONFLICT (code, version) DO NOTHING;

-- Пины и режим детекции у самой ревизии разметки.
ALTER TABLE layout_revisions
  ADD COLUMN layout_profile_id    uuid REFERENCES layout_profiles (id),
  -- Профиль детекции RD WEB (§5.3). `full_page` — явный режим для однородных
  -- текстовых комплектов, и он допустим ТОЛЬКО до первой ручной правки:
  -- full-page-text на их стороне удаляет прежние блоки страницы (проверено по
  -- blocks_bulk.py), то есть после правки он молча уничтожил бы работу человека.
  ADD COLUMN detector_profile     text NOT NULL DEFAULT 'rf_detr',
  -- Момент первой ручной правки. Хранится отдельным столбцом, а не выводится из
  -- наличия блока с source='user': удаление автоблока человеком правкой
  -- является, но никакого следа в наборе блоков не оставляет.
  ADD COLUMN first_manual_edit_at timestamptz,
  ADD COLUMN first_manual_edit_by uuid REFERENCES users (id);

ALTER TABLE layout_revisions
  ADD CONSTRAINT layout_revisions_detector_profile_chk
    CHECK (detector_profile IN ('rf_detr', 'full_page')),
  ADD CONSTRAINT layout_revisions_manual_edit_chk
    CHECK ((first_manual_edit_at IS NULL) = (first_manual_edit_by IS NULL));

CREATE INDEX ix_layout_revisions_profile ON layout_revisions (layout_profile_id);
CREATE INDEX ix_layout_revisions_manual_editor ON layout_revisions (first_manual_edit_by);
