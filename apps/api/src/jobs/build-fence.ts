/**
 * Забор сборки: исполнитель чужой сборки перестаёт брать задачи (S58).
 *
 * ## Что случилось
 *
 * С 6 по 8 сентября задачи портала исполняли ДВА воркера. Рядом с боевым стеком
 * `-p id` жил дубликат, поднятый из каталога `deploy` без `-p id`: compose назвал
 * проект `deploy`, образ взял `id-api:latest` сборки 06.09, а
 * `restart: unless-stopped` провёл его через три выкатки. Оба брали задачи из
 * одной очереди, и какая сборка достанется попытке, решал случай: пока новый
 * воркер был занят анализом папки на 220 листов, простаивающий старый выхватывал
 * почти все `rd.*` и `checks.run`. Отказы выглядели дефектами кода — «нет
 * реализации для кодов REG.113…117», нарушение `rd_exec_documents_document_path_chk`
 * — хотя текущая сборка на тех же папках проходила секундами позже.
 *
 * ## Почему забор, а не «не запускайте второй»
 *
 * Два воркера на одну базу допустимы по построению — так вынесен воркер на
 * отдельную машину (deploy/README, §7). Запрещать второго нельзя; можно
 * требовать, чтобы все исполнители были ОДНОЙ сборки. Чью сборку считать
 * верной, решает API: он один на портал, его пересоздаёт каждая выкатка, и при
 * старте он объявляет свою метку в `app_settings` (`deploy.release`). Воркер
 * сверяет с объявленной свою и при расхождении перестаёт брать задачи и
 * выходит с кодом 1: под `restart: unless-stopped` это видимый цикл перезапусков
 * с `worker_build_stale` в журнале вместо молчаливого конкурента.
 *
 * Воркер сам не объявляет ничего — сирота переобъявил бы себя и снял забор.
 *
 * ## Второй зонд — журнал миграций
 *
 * Объявление меняется только со стартом API, а схема — минутами раньше, на шаге
 * `--migrate`. Воркер на другой машине в это окно сверился бы со СТАРЫМ
 * объявлением и продолжил работать на схеме, которой его код не знает. Поэтому
 * рядом второй признак, не требующий ни объявления, ни настройки: образ несёт
 * каталог `migrations/`, и база, ушедшая дальше него, означает код старше схемы.
 *
 * ## Порядок старта
 *
 * `up -d` поднимает API и воркер одновременно, и воркер может увидеть
 * объявление ПРЕДЫДУЩЕЙ выкатки. Поэтому расхождение в первые `graceMs` после
 * старта — не приговор, а ожидание (`unverified`): захват удержан, проверка
 * повторяется. Расхождение после того, как совпадение уже было, — приговор
 * сразу: это выкатка прошла мимо этого процесса.
 */
import { readdirSync } from 'node:fs';
import type { Logger } from 'pino';

import {
  readDeployRelease,
  readSchemaVersion,
  writeSystemSetting,
} from '../db/repositories/admin.js';
import { DEPLOY_RELEASE_KEY } from '../db/repositories/admin.js';
import type { Database } from '../db/repositories/users.js';
import { errorDigest } from '../observability/errors.js';

export type FenceState = 'disabled' | 'unannounced' | 'unverified' | 'current' | 'stale';

export type StaleReason = 'release_mismatch' | 'unlabeled' | 'schema_newer';

export interface FenceDecision {
  readonly state: FenceState;
  readonly reason: StaleReason | null;
}

export interface FenceVerdict extends FenceDecision {
  readonly own: string | null;
  readonly announced: string | null;
  readonly announcedAt: string | null;
  readonly bundledSchema: string | null;
  readonly dbSchema: string | null;
}

export interface FenceInput {
  /** Метка сборки этого процесса (`APP_RELEASE`). */
  readonly own: string | undefined;
  /** Метка, объявленная API; `null` — объявления нет. */
  readonly announced: string | null;
  readonly production: boolean;
  /** Старшая миграция в каталоге образа; `null` — каталог не найден. */
  readonly bundled: string | null;
  /** Старшая применённая миграция по журналу базы; `null` — журнал не прочитан. */
  readonly dbSchema: string | null;
  /** Совпадение с объявлением уже было: расхождение теперь — выкатка мимо. */
  readonly matchedBefore: boolean;
  readonly sinceStartMs: number;
  readonly graceMs: number;
}

/** Умолчание окна старта: API поднимается рядом и объявляет метку не мгновенно. */
export const DEFAULT_FENCE_GRACE_MS = 90_000;
/** Умолчание периода проверки: выкатка занимает минуты, секунд хватает. */
export const DEFAULT_FENCE_INTERVAL_MS = 15_000;
/** Как часто повторять строку об удержании: цикл опрашивает раз в 15 секунд. */
const HELD_LOG_INTERVAL_MS = 60_000;

/** Имена файлов миграций: `NNNN_slug.sql`, как их читает `@id/migrator`. */
const MIGRATION_FILE = /^(\d{4})_.+\.sql$/u;

/**
 * Старшая миграция каталога образа по ИМЕНАМ файлов.
 *
 * Читать SQL незачем: забору нужен только номер, а версии в журнале — те же
 * четырёхзначные строки, что и префиксы файлов, и сравниваются как строки.
 * Отсутствующий каталог — `null`, а не отказ: зонд схемы вспомогательный, и
 * ронять воркер из-за него нельзя.
 */
export function bundledSchemaVersion(migrationsDir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(migrationsDir);
  } catch {
    return null;
  }
  let max: string | null = null;
  for (const name of names) {
    const match = MIGRATION_FILE.exec(name);
    if (match?.[1] === undefined) continue;
    if (max === null || match[1] > max) max = match[1];
  }
  return max;
}

/**
 * Решение забора — чистая функция, чтобы таблица исходов проверялась без базы.
 *
 * Порядок ветвей значим: зонд схемы стоит первым, потому что он не зависит ни
 * от метки, ни от объявления и говорит о коде процесса напрямую.
 */
export function decideFence(input: FenceInput): FenceDecision {
  if (input.bundled !== null && input.dbSchema !== null && input.dbSchema > input.bundled) {
    return { state: 'stale', reason: 'schema_newer' };
  }

  if (input.own === undefined) {
    // Без метки в production сверять нечего, а работать вслепую нельзя: именно
    // так выглядел бы сирота, поднятый без переменной. Вне production метки нет
    // по умолчанию, и забор выключен.
    if (!input.production) return { state: 'disabled', reason: null };
    return input.sinceStartMs >= input.graceMs
      ? { state: 'stale', reason: 'unlabeled' }
      : { state: 'unverified', reason: null };
  }

  if (input.announced === null) {
    // Первая выкатка с забором или API ещё не поднимался: захват разрешён —
    // иначе воркер, единственный исполнитель, встал бы из-за пустой строки.
    return { state: 'unannounced', reason: null };
  }

  if (input.announced === input.own) return { state: 'current', reason: null };

  return input.matchedBefore || input.sinceStartMs >= input.graceMs
    ? { state: 'stale', reason: 'release_mismatch' }
    : { state: 'unverified', reason: null };
}

/** Захват удержан: сверка не завершена или процесс признан устаревшим. */
export function holdsClaims(state: FenceState): boolean {
  return state === 'unverified' || state === 'stale';
}

/** Объявление метки API при старте (см. `DEPLOY_RELEASE_KEY`). */
export async function announceRelease(
  db: Database,
  release: string,
  logger: Logger,
): Promise<void> {
  await writeSystemSetting(db, DEPLOY_RELEASE_KEY, {
    release,
    announcedBy: 'api',
    announcedAt: new Date().toISOString(),
  });
  logger.info({ event: 'release_announced', release }, 'метка сборки объявлена');
}

export interface BuildFenceOptions {
  readonly db: Database;
  readonly logger: Logger;
  readonly ownRelease: string | undefined;
  readonly production: boolean;
  readonly migrationsDir: string;
  /** Зовётся один раз, когда процесс признан устаревшим. */
  readonly onStale: (verdict: FenceVerdict) => void;
  readonly intervalMs?: number | undefined;
  readonly graceMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export class BuildFence {
  readonly #options: BuildFenceOptions;
  readonly #bundled: string | null;
  readonly #startedAt: number;
  #timer: NodeJS.Timeout | null = null;
  #verdict: FenceVerdict;
  #matchedBefore = false;
  #staleReported = false;
  #schemaWarned = false;
  #heldLoggedAt = 0;

  constructor(options: BuildFenceOptions) {
    this.#options = options;
    this.#bundled = bundledSchemaVersion(options.migrationsDir);
    this.#startedAt = this.#now();
    this.#verdict = {
      state: options.ownRelease === undefined && !options.production ? 'disabled' : 'unverified',
      reason: null,
      own: options.ownRelease ?? null,
      announced: null,
      announcedAt: null,
      bundledSchema: this.#bundled,
      dbSchema: null,
    };
    if (this.#bundled === null) {
      options.logger.warn(
        { event: 'build_fence_no_migrations', dir: options.migrationsDir },
        'каталог миграций не найден: зонд схемы забора сборки выключен',
      );
    }
  }

  get verdict(): FenceVerdict {
    return this.#verdict;
  }

  /** Предикат для `JobRunnerOptions.claimGuard`. */
  holdsClaims(): boolean {
    return holdsClaims(this.#verdict.state);
  }

  /** Первая проверка — до захвата задач; дальше по таймеру. */
  async start(): Promise<void> {
    await this.checkOnce();
    const intervalMs = this.#options.intervalMs ?? DEFAULT_FENCE_INTERVAL_MS;
    this.#timer = setInterval(() => {
      void this.checkOnce().catch((error: unknown) => {
        this.#options.logger.error(
          { event: 'build_fence_check_failed', ...errorDigest(error) },
          'проверка забора сборки не удалась',
        );
      });
    }, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async checkOnce(): Promise<FenceVerdict> {
    const announced = await readDeployRelease(this.#options.db);
    const dbSchema = await this.#readSchema();

    const decision = decideFence({
      own: this.#options.ownRelease,
      announced: announced?.release ?? null,
      production: this.#options.production,
      bundled: this.#bundled,
      dbSchema,
      matchedBefore: this.#matchedBefore,
      sinceStartMs: this.#now() - this.#startedAt,
      graceMs: this.#options.graceMs ?? DEFAULT_FENCE_GRACE_MS,
    });

    const previous = this.#verdict.state;
    this.#verdict = {
      ...decision,
      own: this.#options.ownRelease ?? null,
      announced: announced?.release ?? null,
      announcedAt: announced?.announcedAt ?? null,
      bundledSchema: this.#bundled,
      dbSchema,
    };
    if (decision.state === 'current') this.#matchedBefore = true;

    this.#report(previous);
    return this.#verdict;
  }

  async #readSchema(): Promise<string | null> {
    if (this.#bundled === null) return null;
    try {
      return await readSchemaVersion(this.#options.db);
    } catch (error) {
      // Роль без права на schema_migrations — не причина ронять воркер, но
      // причина сказать об этом: без журнала зонд схемы молчит.
      if (!this.#schemaWarned) {
        this.#schemaWarned = true;
        this.#options.logger.warn(
          { event: 'build_fence_schema_unreadable', ...errorDigest(error) },
          'журнал миграций не прочитан: зонд схемы забора сборки выключен',
        );
      }
      return null;
    }
  }

  #report(previous: FenceState): void {
    const verdict = this.#verdict;
    const details = {
      own: verdict.own,
      announced: verdict.announced,
      announced_at: verdict.announcedAt,
      bundled_schema: verdict.bundledSchema,
      db_schema: verdict.dbSchema,
      reason: verdict.reason,
    };

    switch (verdict.state) {
      case 'stale':
        if (this.#staleReported) return;
        this.#staleReported = true;
        this.#options.logger.error(
          { event: 'worker_build_stale', ...details },
          'сборка воркера не совпадает с выкаткой: задачи больше не берутся',
        );
        this.#options.onStale(verdict);
        return;
      case 'current':
        if (previous !== 'current') {
          this.#options.logger.info(
            { event: 'worker_build_current', ...details },
            'сборка воркера совпадает с объявленной',
          );
        }
        return;
      case 'unannounced':
      case 'unverified': {
        const now = this.#now();
        if (previous === verdict.state && now - this.#heldLoggedAt < HELD_LOG_INTERVAL_MS) return;
        this.#heldLoggedAt = now;
        this.#options.logger.warn(
          { event: `worker_build_${verdict.state}`, ...details },
          verdict.state === 'unannounced'
            ? 'API не объявил метку сборки: забор не сверяет, задачи берутся'
            : 'сборка воркера ещё не сверена с выкаткой: задачи не берутся',
        );
        return;
      }
      case 'disabled':
        if (previous !== 'disabled') {
          this.#options.logger.info(
            { event: 'worker_build_fence_disabled', ...details },
            'метка сборки не задана: забор выключен',
          );
        }
        return;
    }
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }
}
