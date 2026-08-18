/**
 * Срок хранения и удержание данных ревизии (§4.2, §13).
 *
 * ## Что это и чего это НЕ делает
 *
 * §4.2 заканчивается фразой «хранение — до окончания retention policy и снятия
 * legal hold». Это правило РАЗРЕШЕНИЯ на удаление, и оно выражено здесь одной
 * чистой функцией. Само удаление порталом не выполняется: по §4.2 сборка мусора
 * работает отдельной ограниченной ролью, а полное удаление неизменяемых записей
 * — процедурой владельца БД с временно отключёнными триггерами (см. заголовок
 * миграции 0008). Функция отвечает на вопрос «можно ли», а не «сделай».
 *
 * Отсюда и форма ответа: не булево, а причина. «Нельзя» без причины
 * превращается в загадку у оператора, который видит, что место кончилось, и не
 * понимает, почему ничего не чистится, — а различить «срок не вышел» и «стоит
 * удержание» ему нужно для совершенно разных действий.
 *
 * ## Почему решение принимается по `decided_at`
 *
 * Хранить обязаны то, по чему принято решение, и срок логично отсчитывать от
 * решения, а не от загрузки файлов: комплект, пролежавший год на доработке,
 * иначе оказался бы просроченным в день согласования.
 *
 * Ревизия без решения не удаляется вовсе. Это не осторожность, а следствие:
 * черновик и комплект на проверке — это работа, которая ИДЁТ, и срок хранения
 * к ней не относится.
 *
 * ## Почему выключенный legal hold виден в ответе
 *
 * `LEGAL_HOLD_ENABLED=false` — осознанное решение эксплуатации, и оно меняет
 * судьбу данных, на которые кто-то наложил удержание. «Удержания не было» и
 * «удержание проигнорировано настройкой» обязаны различаться в отчёте: второе
 * — это то, о чём юрист захочет узнать до, а не после удаления.
 */

export interface RetentionPolicy {
  /** `RETENTION_DAYS` (§15). */
  readonly retentionDays: number;
  /** `LEGAL_HOLD_ENABLED` (§15). */
  readonly legalHoldEnabled: boolean;
}

export interface RetentionSubject {
  /** Workflow-статус ревизии. */
  readonly status: string;
  /** `decided_at` в ISO-8601; `null` — решения ещё нет. */
  readonly decidedAt: string | null;
  /** Сколько действующих удержаний наложено на ревизию. */
  readonly activeHolds: number;
}

export type RetentionBlock =
  'decision_pending' | 'retention_not_expired' | 'legal_hold' | 'invalid_decision_date';

export interface RetentionDecision {
  /** `true` — данные ревизии разрешено удалять. */
  readonly deletable: boolean;
  /** Причины, по которым удалять нельзя; пусто ⟺ `deletable`. */
  readonly blocks: readonly RetentionBlock[];
  /** Дата окончания срока хранения; `null` — решения по ревизии нет. */
  readonly retainedUntil: string | null;
  /**
   * Удержание наложено, но настройка велит его игнорировать.
   *
   * Отдельное поле, а не отсутствие блока: см. заголовок файла.
   */
  readonly legalHoldOverridden: boolean;
}

/** Терминальные статусы: только по ним срок хранения вообще начинается. */
const DECIDED = new Set(['returned', 'approved', 'superseded']);

const DAY_MS = 24 * 60 * 60 * 1000;

export function decideRetention(
  subject: RetentionSubject,
  policy: RetentionPolicy,
  now: Date = new Date(),
): RetentionDecision {
  const blocks: RetentionBlock[] = [];
  const holdActive = subject.activeHolds > 0;
  const legalHoldOverridden = holdActive && !policy.legalHoldEnabled;

  if (holdActive && policy.legalHoldEnabled) blocks.push('legal_hold');

  if (!DECIDED.has(subject.status) || subject.decidedAt === null) {
    blocks.push('decision_pending');
    return { deletable: false, blocks, retainedUntil: null, legalHoldOverridden };
  }

  const decided = Date.parse(subject.decidedAt);
  if (Number.isNaN(decided)) {
    // Непригодная дата решения не имеет права превратиться в «срок вышел»:
    // NaN в сравнении даёт false, то есть молчаливое разрешение на удаление.
    blocks.push('invalid_decision_date');
    return { deletable: false, blocks, retainedUntil: null, legalHoldOverridden };
  }

  const until = new Date(decided + policy.retentionDays * DAY_MS);
  if (now.getTime() < until.getTime()) blocks.push('retention_not_expired');

  return {
    deletable: blocks.length === 0,
    blocks,
    retainedUntil: until.toISOString(),
    legalHoldOverridden,
  };
}
