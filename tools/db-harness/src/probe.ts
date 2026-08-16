/**
 * Проба тестовой БД (гейт этапа S0).
 *
 * Проверяет, что pglite поднимается, что доступны все три обязательных
 * расширения и что работает `gen_random_uuid()`. Результат определяет,
 * можем ли мы гонять миграции локально или гейт S2 деградирует до
 * статической сверки (см. docs/ADR/0002).
 */
import { createPgliteDatabase, REQUIRED_EXTENSIONS, hasRealPostgres } from './index.js';

async function main(): Promise<void> {
  console.log('Проба pglite...');
  const db = await createPgliteDatabase();

  try {
    const version = await db.query<{ version: string }>('SELECT version()');
    console.log(`  версия: ${version[0]?.version ?? 'неизвестна'}`);

    const installed = await db.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = ANY($1::text[]) ORDER BY extname`,
      [[...REQUIRED_EXTENSIONS]],
    );
    const names = installed.map((r) => r.extname);
    console.log(`  расширения: ${names.join(', ') || 'нет'}`);

    const missing = REQUIRED_EXTENSIONS.filter((e) => !names.includes(e));
    if (missing.length > 0) {
      throw new Error(`не установлены обязательные расширения: ${missing.join(', ')}`);
    }

    // gen_random_uuid() входит в ядро PostgreSQL начиная с 13, но проверяем явно:
    // на нём построены все первичные ключи схемы.
    const uuid = await db.query<{ id: string }>('SELECT gen_random_uuid() AS id');
    if (!uuid[0]?.id) throw new Error('gen_random_uuid() не работает');
    console.log(`  gen_random_uuid(): ок`);

    // citext и pg_trgm используются нормализацией номеров документов.
    const trgm = await db.query<{ sim: number }>(
      `SELECT similarity('РОСС RU Д-RU.PA01', 'РОСС RU Д-РУ.РА01') AS sim`,
    );
    console.log(`  pg_trgm similarity: ${trgm[0]?.sim ?? 'н/д'}`);

    console.log(
      hasRealPostgres()
        ? 'TEST_DATABASE_URL задана — тесты конкурентности будут выполняться.'
        : 'TEST_DATABASE_URL не задана — тесты конкурентности будут пропущены (долг до S12).',
    );
    console.log('Проба пройдена.');
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('Проба провалена:', err);
  process.exitCode = 1;
});
