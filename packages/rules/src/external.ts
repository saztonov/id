/**
 * Внешние реестры (§9.5).
 *
 * Проверки СРО, НРС, аккредитации и графика строительства **не объявляются
 * автоматическими без источника данных**. Это не оговорка о качестве, а вопрос
 * ответственности: «специалист отсутствует в НРС» — юридическое утверждение, и
 * система, не подключённая к реестру, его сделать не может. В MVP доступны
 * только internal- и manual-реализации, поэтому штатный ответ —
 * `unavailable`, а правило порождает `origin='external_unavailable'` с текстом
 * «требуется ручная проверка».
 *
 * ## Почему интерфейсы асинхронны, а правила — нет
 *
 * Реальный провайдер пойдёт в сеть. Правило же обязано оставаться чистой
 * функцией, иначе прогон невоспроизводим (§3.7). Разрыв делается один раз, на
 * сборке графа: `resolveExternalRegistries` опрашивает провайдеров, а правило
 * читает готовый снимок. Отсюда же — отказ провайдера не роняет прогон, а
 * превращается в `unavailable` с названной причиной.
 */
import type {
  AccreditationRecord,
  ExternalLookup,
  ExternalRegistriesSnapshot,
  NrsRecord,
  ScheduleRecord,
  SroRecord,
} from './types.js';

/** Запрос к реестру: что именно проверяем. */
export interface RegistryQuery {
  readonly objectId: string;
  readonly contractorId: string;
  /** ИНН участников комплекта — вход для СРО. */
  readonly inns: readonly string[];
  /** Фамилии подписантов — вход для НРС. */
  readonly people: readonly string[];
  /** Номера аттестатов аккредитации, встреченные в протоколах. */
  readonly accreditationNumbers: readonly string[];
  /** Даты, на которые нужен ответ. */
  readonly onDates: readonly string[];
}

export interface NrsRegistryProvider {
  readonly name: string;
  lookupSpecialists(query: RegistryQuery): Promise<ExternalLookup<NrsRecord>>;
}

export interface SroRegistryProvider {
  readonly name: string;
  lookupMembership(query: RegistryQuery): Promise<ExternalLookup<SroRecord>>;
}

export interface AccreditationRegistryProvider {
  readonly name: string;
  lookupAccreditation(query: RegistryQuery): Promise<ExternalLookup<AccreditationRecord>>;
}

export interface ProjectScheduleProvider {
  readonly name: string;
  lookupSchedule(query: RegistryQuery): Promise<ExternalLookup<ScheduleRecord>>;
}

export interface ExternalRegistryProviders {
  readonly nrs: NrsRegistryProvider;
  readonly sro: SroRegistryProvider;
  readonly accreditation: AccreditationRegistryProvider;
  readonly schedule: ProjectScheduleProvider;
}

/**
 * Причина недоступности, общая для MVP.
 *
 * Текст один и на виду: он попадает в замечание, которое читает инженер, и
 * должен объяснять, что делать, а не сообщать о технической неудаче.
 */
export const NO_SOURCE_REASON =
  'источник данных не подключён: в MVP доступны только internal- и manual-реализации';

/** Провайдер без источника данных. Штатное состояние MVP, а не отказ. */
class UnavailableProvider {
  constructor(readonly name: string) {}

  private answer<T>(): Promise<ExternalLookup<T>> {
    return Promise.resolve({ status: 'unavailable', reason: NO_SOURCE_REASON });
  }

  lookupSpecialists(): Promise<ExternalLookup<NrsRecord>> {
    return this.answer<NrsRecord>();
  }

  lookupMembership(): Promise<ExternalLookup<SroRecord>> {
    return this.answer<SroRecord>();
  }

  lookupAccreditation(): Promise<ExternalLookup<AccreditationRecord>> {
    return this.answer<AccreditationRecord>();
  }

  lookupSchedule(): Promise<ExternalLookup<ScheduleRecord>> {
    return this.answer<ScheduleRecord>();
  }
}

/** Набор провайдеров MVP: ни один источник не подключён (§9.5). */
export function createInternalRegistryProviders(): ExternalRegistryProviders {
  return {
    nrs: new UnavailableProvider('internal'),
    sro: new UnavailableProvider('internal'),
    accreditation: new UnavailableProvider('internal'),
    schedule: new UnavailableProvider('internal'),
  };
}

/**
 * Ручной провайдер: сведения, введённые администратором.
 *
 * Единственная реализация контракта провайдера, отвечающая `available`. Нужна
 * `external.test.ts`, чтобы пройти ШОВ `resolveExternalRegistries` целиком —
 * от провайдера до вердикта правила. Ветку доступности сама по себе она не
 * доказывает: вердикты при доступном источнике проверяются в `aosr.test.ts`
 * подстановкой `graph.external`. Доказывает она другое и не покрытое ничем
 * иным — что снимок, собранный из провайдеров штатным путём, доходит до
 * правила и гасит `external_unavailable`; между «правило умеет читать снимок»
 * и «сборка графа этот снимок ему приносит» ровно тот зазор, в котором на S3
 * жил написанный, но не подключённый слой наблюдаемости.
 *
 * Второе назначение — эксплуатационное: заказчик может завести выписку из
 * реестра руками до появления интеграции.
 */
export function createManualProvider<T>(records: readonly T[]): {
  lookupSpecialists(): Promise<ExternalLookup<T>>;
  lookupMembership(): Promise<ExternalLookup<T>>;
  lookupAccreditation(): Promise<ExternalLookup<T>>;
  lookupSchedule(): Promise<ExternalLookup<T>>;
  readonly name: string;
} {
  const answer = (): Promise<ExternalLookup<T>> =>
    Promise.resolve({ status: 'available', records });
  return {
    name: 'manual',
    lookupSpecialists: answer,
    lookupMembership: answer,
    lookupAccreditation: answer,
    lookupSchedule: answer,
  };
}

/**
 * Снимок ответов реестров на момент прогона.
 *
 * Отказ провайдера превращается в `unavailable`, а не роняет прогон: комплект
 * обязан быть проверен до конца, а «реестр не ответил» — это ровно то
 * состояние, ради которого §9.5 введено значение `external_unavailable`.
 */
export async function resolveExternalRegistries(
  providers: ExternalRegistryProviders,
  query: RegistryQuery,
): Promise<ExternalRegistriesSnapshot> {
  const guard = async <T>(
    call: () => Promise<ExternalLookup<T>>,
    label: string,
  ): Promise<ExternalLookup<T>> => {
    try {
      return await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'unavailable', reason: `${label}: ${message}` };
    }
  };

  const [nrs, sro, accreditation, schedule] = await Promise.all([
    guard(() => providers.nrs.lookupSpecialists(query), 'реестр НРС недоступен'),
    guard(() => providers.sro.lookupMembership(query), 'реестр СРО недоступен'),
    guard(
      () => providers.accreditation.lookupAccreditation(query),
      'реестр аккредитации недоступен',
    ),
    guard(() => providers.schedule.lookupSchedule(query), 'график строительства недоступен'),
  ]);

  return { nrs, sro, accreditation, schedule };
}
