/**
 * Тестовая БД для гейтов.
 *
 * По умолчанию — pglite (настоящий PostgreSQL, собранный в WASM): работает
 * в процессе Node без Docker и без внешних бинарников. `embedded-postgres`
 * не используется: у него нет ни одного стабильного релиза.
 *
 * Ограничение pglite — одно соединение. Тесты, которым нужна истинная
 * конкурентность (`FOR UPDATE SKIP LOCKED` двумя воркерами), должны
 * проверять `hasRealPostgres()` и пропускаться, когда её нет.
 */

/** Расширения, которые боевая БД получает вручную до миграций. */
export const REQUIRED_EXTENSIONS = ['pgcrypto', 'citext', 'pg_trgm'] as const;

export type RequiredExtension = (typeof REQUIRED_EXTENSIONS)[number];

/** Минимальный интерфейс тестовой БД, общий для pglite и настоящей PostgreSQL. */
export interface TestDatabase {
  readonly kind: 'pglite' | 'postgres';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * Та же выборка, но значения строки — ПОЗИЦИОННО, а не по именам колонок.
   *
   * Существует ровно ради Drizzle: он запрашивает `rowMode: 'array'` и
   * сопоставляет значения с полями по порядку. Собирать массив из объектного
   * ответа (`Object.values(row)`) нельзя — объект схлопывает одноимённые
   * колонки, и `select a.id, b.id` даёт одно значение вместо двух. Сдвиг после
   * этого молчаливый: тест зелёный, данные не те. pglite умеет позиционный
   * режим сам, поэтому он и пробрасывается.
   */
  queryArray(sql: string, params?: unknown[]): Promise<unknown[][]>;
  /**
   * Многооператорный SQL без параметров.
   *
   * `query` в pglite идёт через расширенный протокол и допускает ровно один
   * оператор, поэтому тело миграции им выполнить нельзя.
   */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Задана ли строка подключения к настоящей PostgreSQL.
 * Тесты на конкурентность и на реальное применение миграций опираются на неё.
 */
export function hasRealPostgres(): boolean {
  return (
    typeof process.env['TEST_DATABASE_URL'] === 'string' && process.env['TEST_DATABASE_URL'] !== ''
  );
}

/**
 * Поднимает эфемерную БД в памяти на pglite и включает обязательные расширения.
 *
 * В pglite contrib-расширения не встроены в ядро: их бандлы подключаются
 * через опцию `extensions`, и только после этого `CREATE EXTENSION` находит
 * control-файл. Без этого запрос падает в `parse_extension_control_file`.
 */
export interface PgliteOptions {
  /**
   * Каталог для файловой БД. По умолчанию БД живёт в памяти.
   *
   * Файловый вариант нужен генератору схемы Drizzle: `drizzle-kit introspect`
   * подключается к БД отдельным процессом и памяти предыдущего не видит.
   */
  readonly dataDir?: string;
}

/**
 * Даты и метки времени — СЫРЫМ текстом, как их видит Drizzle через `pg`.
 *
 * Drizzle подменяет парсеры типов драйвера на тождественные и разбирает
 * временны́е значения сама. pglite по умолчанию отдаёт `Date`, а приведение
 * `Date` к ISO ломает именно `date`: колонка `effective_from` со значением
 * `2026-06-01` превратилась бы в `2026-06-01T00:00:00.000Z` и не прошла бы
 * схему ответа. Поэтому на пути Drizzle разбор отключается, а не исправляется
 * после него.
 *
 * OID: 1082 `date`, 1114 `timestamp`, 1184 `timestamptz`.
 */
const RAW_TEMPORAL_PARSERS: Record<number, (value: string) => string> = {
  1082: (value) => value,
  1114: (value) => value,
  1184: (value) => value,
};

export async function createPgliteDatabase(options: PgliteOptions = {}): Promise<TestDatabase> {
  const [{ PGlite }, { pgcrypto }, { citext }, { pg_trgm }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite/contrib/pgcrypto'),
    import('@electric-sql/pglite/contrib/citext'),
    import('@electric-sql/pglite/contrib/pg_trgm'),
  ]);

  const db = await PGlite.create({
    extensions: { pgcrypto, citext, pg_trgm },
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
  });

  for (const ext of REQUIRED_EXTENSIONS) {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS ${ext};`);
  }

  return {
    kind: 'pglite',
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      const res = await db.query<T>(sql, params as unknown[] | undefined);
      return res.rows;
    },
    async queryArray(sql: string, params?: unknown[]): Promise<unknown[][]> {
      const res = await db.query<unknown[]>(sql, params as unknown[] | undefined, {
        rowMode: 'array',
        parsers: RAW_TEMPORAL_PARSERS,
      });
      return res.rows;
    },
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}

// =====================================================================
// Пул поверх тестовой БД для Drizzle
// =====================================================================

/** Запрос в форме, в которой его присылает Drizzle. */
export interface PoolQueryConfig {
  readonly text: string;
  readonly rowMode?: 'array' | undefined;
}

export interface PoolQueryOutcome {
  rows: unknown[];
  rowCount: number;
}

export interface PoolClientLike {
  query(source: string | PoolQueryConfig, values?: unknown[]): Promise<PoolQueryOutcome>;
  release(): void;
}

export interface PoolLike {
  query(source: string | PoolQueryConfig, values?: unknown[]): Promise<PoolQueryOutcome>;
  connect(): Promise<PoolClientLike>;
  end(): Promise<void>;
}

/**
 * Адаптер тестовой БД под интерфейс `pg.Pool`, которого ждёт Drizzle.
 *
 * Один на все тесты намеренно. Раньше эта дюжина строк была скопирована в
 * десяток файлов, и в девяти из них позиционный режим собирался через
 * `Object.values()` — то есть с потерей одноимённых колонок и последующим
 * сдвигом полей (см. `queryArray`). Дефект такого рода не проявляется отказом:
 * тест остаётся зелёным, а данные приезжают чужие. Поэтому реализация обязана
 * быть одна.
 *
 * Одно соединение pglite означает, что `connect()` отдаёт тот же исполнитель:
 * настоящей изоляции транзакций здесь нет, и тесты на конкурентность обязаны
 * проверять `hasRealPostgres()`.
 */
export function createTestPool(db: TestDatabase): PoolLike {
  return new Pool(db);
}

/**
 * Имя класса значимо.
 *
 * Драйвер `node-postgres` в Drizzle отличает пул от одиночного клиента по имени
 * конструктора. Объектный литерал с теми же методами он принял бы за клиента, и
 * транзакции перестали бы брать соединение.
 */
class Pool implements PoolLike {
  readonly #db: TestDatabase;

  constructor(db: TestDatabase) {
    this.#db = db;
    this.query = this.query.bind(this);
  }

  async query(source: string | PoolQueryConfig, values?: unknown[]): Promise<PoolQueryOutcome> {
    // Строка первым аргументом — прямой вызов мимо Drizzle (сессии, область
    // видимости). Он идёт и мимо её парсеров типов, поэтому метки времени
    // обязаны остаться объектами `Date`, как их отдаёт настоящий `pg`.
    if (typeof source === 'string') {
      const raw = await this.#db.query<Record<string, unknown>>(source, values);
      return { rows: raw, rowCount: raw.length };
    }

    // Drizzle подменяет парсеры типов и оставляет метки времени ТЕКСТОМ,
    // поэтому на её пути `Date` приводится к ISO-8601.
    if (source.rowMode === 'array') {
      const rows = await this.#db.queryArray(source.text, values);
      return { rows: rows.map((row) => row.map(normalizeCell)), rowCount: rows.length };
    }

    const rows = await this.#db.query<Record<string, unknown>>(source.text, values);
    return { rows: rows.map(normalizeRow), rowCount: rows.length };
  }

  connect(): Promise<PoolClientLike> {
    return Promise.resolve({ query: this.query, release: (): void => undefined });
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

function normalizeCell(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = normalizeCell(value);
  return out;
}

// =====================================================================
// Дерево «объект → комплект → ревизия» для фикстур тестов
// =====================================================================

/**
 * Одинаковая пятёрка INSERT'ов, с которой начинается почти каждый тест.
 *
 * До 0028 она была семёркой (`section_kinds`, `object_sections`, `volumes`,
 * `submissions`, `submission_revisions`), выписанной вручную примерно в
 * тридцати пяти файлах. Каждая правка схемы означала тридцать пять
 * механических правок, и на S19 стало видно, чем это кончается: часть файлов
 * расходится с остальными не по смыслу теста, а по тому, кто из авторов
 * скопировал более старую версию.
 *
 * Функция возвращает МАССИВ SQL-строк, а не выполняет их: тесты в проекте
 * держат фикстуру списком строк и прогоняют его сами (иногда — вперемешку со
 * своими вставками, иногда — в другой транзакции). Возврат строк сохраняет этот
 * стиль и не навязывает исполнителя.
 *
 * Идентификаторы передаются вызывающим, а не генерируются здесь: тесты
 * проверяют ответы по конкретным UUID и печатают их в ожиданиях.
 */
export interface RevisionTreeIds {
  /** Организация-исполнитель. Строку `counterparties` создаёт вызывающий. */
  readonly contractorId: string;
  readonly objectId: string;
  readonly userId: string;
  readonly workId: string;
  readonly revisionId: string;
  /** Код раздела работ. Заводится этой же функцией, если его ещё нет. */
  readonly sectionCode?: string;
  readonly sectionName?: string;
  /** Месяц комплекта первым числом. По умолчанию — январь 2026. */
  readonly period?: string;
  readonly workTitle?: string;
  readonly revisionNo?: number;
  readonly revisionStatus?: string;
  /**
   * Организация, ведущая комплект. По умолчанию совпадает с исполнителем;
   * задаётся отдельно там, где комплект заводит ПТО генподрядчика.
   */
  readonly managedByContractorId?: string;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function revisionTreeSql(ids: RevisionTreeIds): string[] {
  const sectionCode = ids.sectionCode ?? 'roofing';
  const sectionName = ids.sectionName ?? 'Кровля';
  const period = ids.period ?? '2026-01-01';
  const title = ids.workTitle ?? 'Комплект работ';
  const managedBy = ids.managedByContractorId ?? ids.contractorId;

  return [
    // `ON CONFLICT DO NOTHING`: раздел общий для портала, и второй комплект того
    // же раздела в той же фикстуре не должен ронять вставку.
    `INSERT INTO sections (code, name) VALUES (${quote(sectionCode)}, ${quote(sectionName)})
       ON CONFLICT (code) DO NOTHING`,
    `INSERT INTO object_sections (object_id, section_code)
       VALUES ('${ids.objectId}', ${quote(sectionCode)}) ON CONFLICT DO NOTHING`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${ids.objectId}', '${ids.contractorId}') ON CONFLICT DO NOTHING`,
    `INSERT INTO object_contractors (object_id, contractor_id)
       VALUES ('${ids.objectId}', '${managedBy}') ON CONFLICT DO NOTHING`,
    `INSERT INTO works
       (id, object_id, contractor_id, managed_by_contractor_id, section_code, period, title, created_by)
     VALUES ('${ids.workId}', '${ids.objectId}', '${ids.contractorId}', '${managedBy}',
             ${quote(sectionCode)}, DATE ${quote(period)}, ${quote(title)}, '${ids.userId}')`,
    `INSERT INTO submission_revisions (id, work_id, object_id, contractor_id, revision_no, status)
     VALUES ('${ids.revisionId}', '${ids.workId}', '${ids.objectId}', '${ids.contractorId}',
             ${String(ids.revisionNo ?? 1)}, ${quote(ids.revisionStatus ?? 'draft')})`,
  ];
}
