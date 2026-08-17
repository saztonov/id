/**
 * Состояния промта и версии набора правил — общий конечный автомат (§10, §3.7).
 *
 * Модуль чистый: ни БД, ни Fastify, ни `problem.ts`. Причина не в эстетике.
 * Во-первых, тот же автомат нужен экрану администрирования, чтобы гасить кнопки
 * недопустимых переходов, а не узнавать о запрете из 409. Во-вторых, набор
 * переходов — это правило методики, и оно должно проверяться без поднятой БД:
 * тест «из published нельзя в draft» не обязан ничего мигрировать.
 *
 * Пока экран не получил переходы отдельным полем ответа, их несёт текст отказа:
 * каждый отказ `evaluateTransition` называет допустимые выходы из текущего
 * состояния (`exitsSentence`). Это не замена выдаче списка в GET-ответе, но
 * убирает худшее — угадывание перебором.
 *
 * Автомат один на две сущности, но множества состояний у них РАЗНЫЕ, и это не
 * упущение схемы:
 *
 *   • у промта состояние — колонка `prompt_templates.state` с четырьмя
 *     значениями, и archived реально нужен: rollback публикует прежнюю версию,
 *     значит она обязана где-то лежать в неактивном виде;
 *   • у версии набора правил состояния как колонки нет вовсе — есть
 *     `ruleset_versions.published_at`, то есть ровно два состояния. Триггер 0008
 *     запрещает опубликованной версии ЛЮБОЙ UPDATE, включая «архивацию», потому
 *     что прогон проверок ссылается на версию по id и обязан воспроизводиться
 *     месяц спустя. Поэтому откат набора — это не переход состояния, а
 *     переключение указателя активной версии (см. `rollbackMechanism`).
 *
 * Отсюда же различие в требованиях к публикации: промт обязан пройти `test`
 * (§10: draft → test → publish, dry-run на выбранной ревизии), а версия набора
 * правил публикуется из черновика сразу — её «прогон» это сверка кодов правил с
 * реализациями (§9.6), а не выполнение на данных.
 */

/** Сущность, жизненный цикл которой описан здесь. */
export type GovernedEntity = 'prompt' | 'ruleset';

/**
 * Состояние. Полное множество — у промта; у версии набора правил используются
 * только `draft` и `published` (см. `statesOf`).
 */
export type GovernanceState = 'draft' | 'test' | 'published' | 'archived';

/**
 * Смысл перехода, а не его имя.
 *
 * Вызывающий переключается по нему, а не сравнивает пары состояний: иначе
 * добавление состояния потребовало бы правки каждого switch в репозитории.
 */
export type TransitionKind = 'promote' | 'demote' | 'publish' | 'rollback' | 'archive';

export type TransitionDenialCode =
  /** Состояние не входит в множество этой сущности. */
  | 'state-not-supported'
  /** Переход в то же состояние: не отказ по правилам, но и не действие. */
  | 'no-op'
  /** Опубликованное неизменяемо (§3.9): исправление — новая версия. */
  | 'published-immutable'
  /** Из архива содержимое не оживает: архив — источник для отката, не черновик. */
  | 'archived-content-frozen'
  /** Промт публикуется только после стадии test (§10). */
  | 'requires-test-stage'
  /** Пара состояний не предусмотрена методикой. */
  | 'transition-not-allowed';

/** Что обязан сделать репозиторий помимо смены самого состояния. */
export interface TransitionEffects {
  /**
   * Перевести прежнюю опубликованную версию того же кода в `archived`.
   *
   * Не удобство, а условие выполнимости: `ux_prompt_templates_single_published`
   * допускает одну опубликованную версию на код, поэтому публикация без
   * архивации прежней упадёт на уникальном индексе. Обе операции обязаны быть в
   * одной транзакции.
   */
  readonly archivesPreviousPublished: boolean;
  /** Записать `published_at` и `published_by`. */
  readonly stampsPublication: boolean;
}

export interface TransitionAllowed {
  readonly allowed: true;
  readonly kind: TransitionKind;
  readonly effects: TransitionEffects;
}

export interface TransitionDenied {
  readonly allowed: false;
  readonly code: TransitionDenialCode;
  /** Текст для пользователя: что именно нельзя и что делать вместо этого. */
  readonly explanation: string;
}

export type TransitionVerdict = TransitionAllowed | TransitionDenied;

export interface EditAllowed {
  readonly allowed: true;
}

export interface EditDenied {
  readonly allowed: false;
  readonly code: Extract<
    TransitionDenialCode,
    'published-immutable' | 'archived-content-frozen' | 'state-not-supported'
  >;
  readonly explanation: string;
}

export type EditVerdict = EditAllowed | EditDenied;

/**
 * Механизм отката.
 *
 * У промта прежняя версия возвращается в `published` (её текст при этом не
 * менялся ни разу — правки в `archived` запрещены `evaluateContentEdit`).
 * У набора правил версии не меняются никогда, поэтому откат — переключение
 * указателя активной версии в `app_settings`.
 *
 * Значение видно администратору: по нему выбирается фраза «как вернуть прежнее» в
 * объяснении отказа на правку опубликованного (`ROLLBACK_HINT`). Держать это
 * объявление в стороне от текста нельзя — тогда механизм и подсказка расходятся
 * молча, и человек ищет кнопку, которой у сущности нет.
 */
export type RollbackMechanism = 'republish_previous_version' | 'switch_active_pointer';

const PROMPT_STATES: readonly GovernanceState[] = ['draft', 'test', 'published', 'archived'];
const RULESET_STATES: readonly GovernanceState[] = ['draft', 'published'];

type TransitionTable = Readonly<
  Partial<Record<GovernanceState, Readonly<Partial<Record<GovernanceState, TransitionKind>>>>>
>;

const PROMPT_TRANSITIONS: TransitionTable = {
  draft: { test: 'promote', archived: 'archive' },
  test: { draft: 'demote', published: 'publish', archived: 'archive' },
  // published -> archived снимает промт с эксплуатации; единственный переход,
  // который триггер 0008 оставляет опубликованной строке.
  published: { archived: 'archive' },
  // archived -> published и есть откат: указатель «какая версия опубликована»
  // переезжает на прежнюю, текст не правится.
  archived: { published: 'rollback' },
};

const RULESET_TRANSITIONS: TransitionTable = {
  draft: { published: 'publish' },
  published: {},
};

const TRANSITIONS: Readonly<Record<GovernedEntity, TransitionTable>> = {
  prompt: PROMPT_TRANSITIONS,
  ruleset: RULESET_TRANSITIONS,
};

const ENTITY_TITLE: Readonly<Record<GovernedEntity, string>> = {
  prompt: 'промт',
  ruleset: 'версия набора правил',
};

export function statesOf(entity: GovernedEntity): readonly GovernanceState[] {
  return entity === 'prompt' ? PROMPT_STATES : RULESET_STATES;
}

export function supportsState(entity: GovernedEntity, state: GovernanceState): boolean {
  return statesOf(entity).includes(state);
}

export function rollbackMechanism(entity: GovernedEntity): RollbackMechanism {
  return entity === 'prompt' ? 'republish_previous_version' : 'switch_active_pointer';
}

/** Состояния, в которых содержимое ещё можно править. */
export function editableStates(entity: GovernedEntity): readonly GovernanceState[] {
  return statesOf(entity).filter((state) => state === 'draft' || state === 'test');
}

/**
 * Куда можно уйти из состояния. Пустой список — состояние терминальное.
 *
 * Не справочная функция: список попадает в текст КАЖДОГО отказа
 * `evaluateTransition` (см. `exitsSentence`). Наружу из роута смены состояния
 * уходит одно поле `explanation`, поэтому иначе интерфейс узнавал бы допустимые
 * переходы единственным способом — перебирая их и собирая 409 на каждый
 * недопустимый. Заодно это исключает расхождение: и подсказка, и запись
 * пропускаются одной таблицей.
 */
export function allowedTransitions(
  entity: GovernedEntity,
  from: GovernanceState,
): readonly GovernanceState[] {
  const row = TRANSITIONS[entity][from];
  if (row === undefined) return [];
  return Object.keys(row).filter((state): state is GovernanceState =>
    supportsState(entity, state as GovernanceState),
  );
}

export function evaluateTransition(
  entity: GovernedEntity,
  from: GovernanceState,
  to: GovernanceState,
): TransitionVerdict {
  const unsupported = unsupportedState(entity, from, to);
  if (unsupported !== null) return unsupported;

  const kind = TRANSITIONS[entity][from]?.[to];
  if (kind === undefined) return denyTransition(entity, from, to);

  return {
    allowed: true,
    kind,
    effects: {
      archivesPreviousPublished: entity === 'prompt' && to === 'published',
      stampsPublication: to === 'published',
    },
  };
}

/**
 * Можно ли править содержимое в этом состоянии.
 *
 * Запрет на правку `archived` важнее, чем кажется, и держится только здесь:
 * триггеров на архивную строку в БД нет. Без запрета откат перестаёт быть
 * откатом — архивную версию можно переписать и «вернуть» под её прежним
 * номером уже с другим текстом, а кэш ответов LLM и записи `ai_runs` остались
 * бы посчитанными по прежнему.
 */
export function evaluateContentEdit(entity: GovernedEntity, state: GovernanceState): EditVerdict {
  if (!supportsState(entity, state)) {
    return {
      allowed: false,
      code: 'state-not-supported',
      explanation: `Состояние «${state}» не применимо к сущности «${ENTITY_TITLE[entity]}».`,
    };
  }

  if (state === 'draft' || state === 'test') return { allowed: true };

  if (state === 'published') {
    return {
      allowed: false,
      code: 'published-immutable',
      explanation: publishedImmutableExplanation(entity),
    };
  }

  return {
    allowed: false,
    code: 'archived-content-frozen',
    explanation:
      'Архивную версию править нельзя: именно её текст возвращается в работу при откате. ' +
      'Создайте новую версию — прежняя останется тем, по чему считались прошлые прогоны.',
  };
}

function unsupportedState(
  entity: GovernedEntity,
  from: GovernanceState,
  to: GovernanceState,
): TransitionDenied | null {
  const missing = [from, to].find((state) => !supportsState(entity, state));
  if (missing === undefined) return null;

  return {
    allowed: false,
    code: 'state-not-supported',
    explanation:
      entity === 'ruleset' && (missing === 'test' || missing === 'archived')
        ? `У версии набора правил нет состояния «${missing}»: она либо черновик, либо ` +
          'опубликована навсегда — на неё ссылаются прогоны проверок. ' +
          'Смена действующего набора выполняется переключением активной версии.'
        : `Состояние «${missing}» не применимо к сущности «${ENTITY_TITLE[entity]}».`,
  };
}

/**
 * Отказ по паре состояний. `from` здесь заведомо принадлежит сущности: чужое
 * состояние отсеяно раньше, в `unsupportedState`.
 *
 * К любому отказу дописывается список допустимых выходов. Без него отказ
 * сообщает только запрет, и интерфейсу остаётся перебор: нажать, получить 409,
 * попробовать следующее.
 */
function denyTransition(
  entity: GovernedEntity,
  from: GovernanceState,
  to: GovernanceState,
): TransitionDenied {
  const exits = exitsSentence(entity, from);

  if (from === to) {
    return {
      allowed: false,
      code: 'no-op',
      explanation: `Состояние уже «${from}»: менять нечего.${exits}`,
    };
  }

  if (from === 'published') {
    return {
      allowed: false,
      code: 'published-immutable',
      explanation: publishedImmutableExplanation(entity) + exits,
    };
  }

  if (from === 'archived') {
    return {
      allowed: false,
      code: 'archived-content-frozen',
      explanation:
        'Из архива версия возвращается только публикацией как есть. ' +
        'Чтобы получить черновик, создайте новую версию — правка архивной подменила бы ' +
        `то, к чему откатываются прошлые прогоны.${exits}`,
    };
  }

  if (entity === 'prompt' && from === 'draft' && to === 'published') {
    return {
      allowed: false,
      code: 'requires-test-stage',
      explanation:
        'Публикация из черновика запрещена: промт обязан пройти стадию «test», ' +
        'где его прогоняют dry-run на выбранной ревизии без записи результатов (§10). ' +
        `Переведите версию в «test», затем публикуйте.${exits}`,
    };
  }

  return {
    allowed: false,
    code: 'transition-not-allowed',
    explanation: `Переход «${from}» → «${to}» не предусмотрен методикой.${exits}`,
  };
}

/** Перечень допустимых выходов из состояния — машинно порождённый, отдельной фразой. */
function exitsSentence(entity: GovernedEntity, from: GovernanceState): string {
  const exits = allowedTransitions(entity, from);
  if (exits.length === 0) return ` Из «${from}» переходов нет вовсе.`;
  return ` Доступные переходы из «${from}»: ${exits.map((state) => `«${state}»`).join(', ')}.`;
}

/**
 * Как у сущности выглядит откат — одной формулировкой на портал.
 *
 * Текст выбирается по МЕХАНИЗМУ, а не по сущности: механизм и есть то, чем откат
 * промта отличается от отката набора правил, и объявлен он в
 * `rollbackMechanism()`. Пока фраза была вписана в объяснение руками, объявление
 * механизма не влияло ни на что, и третья сущность получила бы новый механизм в
 * одном месте и прежнюю подсказку в другом.
 */
const ROLLBACK_HINT: Readonly<Record<RollbackMechanism, string>> = {
  republish_previous_version: 'действующую можно снять в архив, а прежнюю вернуть откатом',
  switch_active_pointer: 'откат — переключение активной версии на прежнюю',
};

function publishedImmutableExplanation(entity: GovernedEntity): string {
  const rollback = ROLLBACK_HINT[rollbackMechanism(entity)];
  return entity === 'prompt'
    ? 'Опубликованный промт неизменяем: по его тексту посчитаны прошлые ответы модели. ' +
        `Правка вносится новой версией; ${rollback}.`
    : 'Опубликованная версия набора правил неизменяема: на неё ссылаются выполненные ' +
        'прогоны проверок, и прогон месячной давности обязан воспроизводиться точно. ' +
        `Изменение поведения правил — публикация новой версии, ${rollback}.`;
}
