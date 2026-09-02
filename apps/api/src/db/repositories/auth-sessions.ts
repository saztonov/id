/**
 * Уборка отработавших строк `auth_sessions`.
 *
 * Индекс `ix_auth_sessions_expiry` (миграция 0001) создан ровно под этот запрос
 * и до сих пор не имел ни одного читателя: строки копились с первого дня
 * работы портала. Со сроком сессии в неделю и cookie, переживающей закрытие
 * браузера, накапливаться они стали бы заметно быстрее.
 *
 * ## Почему удаление, а не архив
 *
 * В строке лежат `ip` и `ua` — сведения о человеке (§15). Журналом входов
 * служит `audit_log` (`auth.login`/`auth.logout`), где адрес хранится только
 * как HMAC; `auth_sessions` — рабочее состояние, а не запись о событии, и
 * держать его годами значит годами держать персональные данные без основания.
 *
 * ## Почему с отсрочкой, а не сразу по истечении
 *
 * Разбор «кто и откуда входил на прошлой неделе» опирается на эти же строки, и
 * удаление в момент истечения выносило бы улики раньше, чем о них спросят.
 * Срок хранения поэтому отсчитывается от конца сессии, а не совпадает с ним.
 *
 * ## Почему пакетами и под блокировкой
 *
 * Дословно по образцу `pruneJournal`: цикл живёт в каждом процессе с
 * `JobRunner`, а работать должен один — иначе процессы удаляют одни строки,
 * блокируя друг друга и раздувая WAL. Пакеты не дают удалению накопленного
 * хвоста держать долгую транзакцию на таблице, в которую в этот момент пишет
 * каждый вход.
 */
import { sql } from 'drizzle-orm';

import type { Database } from './users.js';

export interface PruneSessionsParams {
  /** Сколько держать строку после конца сессии. */
  readonly retentionDays: number;
  readonly batchSize?: number | undefined;
}

export interface PruneSessionsResult {
  readonly deleted: number;
  readonly locked: boolean;
}

/** Ключ advisory-блокировки. Произвольная константа, важна её уникальность. */
const PRUNE_LOCK_KEY = 0x1d0a_5e55;

export async function pruneExpiredSessions(
  db: Database,
  params: PruneSessionsParams,
): Promise<PruneSessionsResult> {
  const batch = params.batchSize ?? 5_000;

  const lock = await db.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_lock(${PRUNE_LOCK_KEY}) AS locked`,
  );
  if (lock.rows[0]?.locked !== true) return { deleted: 0, locked: false };

  try {
    let deleted = 0;
    for (;;) {
      // Условие одно, хотя истечь сессия могла и по отзыву: отозванная строка
      // всё равно доживает до своего `absolute_expires_at`, и вторая ветка
      // означала бы вторую политику хранения там, где хватает одной.
      const removed = await db.execute<{ id: string }>(sql`
        DELETE FROM auth_sessions WHERE ctid IN (
          SELECT ctid FROM auth_sessions
           WHERE absolute_expires_at < now() - make_interval(days => ${params.retentionDays})
           LIMIT ${batch}
        ) RETURNING id
      `);
      deleted += removed.rows.length;
      if (removed.rows.length < batch) break;
    }

    return { deleted, locked: true };
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${PRUNE_LOCK_KEY})`);
  }
}
