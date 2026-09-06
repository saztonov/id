/**
 * Живая проба связи с контуром `/api/executive/v1`.
 *
 * ## Зачем она отдельно от прогона
 *
 * До неё единственным способом узнать, работает ли связь, был запуск
 * распознавания: отказ приходил посреди работы, задачей `rd.sync_init`, и
 * администратор видел код контракта вместо действия. Проба задаёт тот же вопрос
 * заранее и отвечает не «да/нет», а вердиктом: чинить приходится разное —
 * удостоверение, права, список проектов, рубильник контура или адрес.
 *
 * ## Почему проба ходит именно в `init`, а не только читает
 *
 * Порядок проверок на той стороне известен по их коду: право → лимит → чтение
 * тела → доступ к ПРОЕКТУ → и только потом `init_sync`, где первым делом
 * проверяется рубильник контура и лишь затем разбирается манифест. Обе
 * последние преграды стоят ЗА телом запроса, и чтением их не достать: проба,
 * которая только читает, покажет зелёный свет на выключенном контуре и на
 * неразрешённом проекте.
 *
 * Поэтому шаг 1 посылает тело, заведомо не являющееся манифестом, и УСПЕХОМ
 * считает отказ `422`: дойти до разбора манифеста можно, только пройдя все
 * преграды разом. Ответ `2xx` на таком теле — не успех, а неожиданность, и
 * докладывается именно так: он означал бы, что удалённая сторона приняла за
 * снимок то, что снимком не является.
 *
 * Ничего при этом не создаётся: разбор манифеста на их стороне идёт до первой
 * записи в базу.
 *
 * Шаг 2 читает заведомо отсутствующую синхронизацию и ждёт `404
 * sync_not_found` — это подтверждает право на чтение, которое порталу нужно
 * позже, чтобы забрать результаты по блокам.
 */
import type { ExecSyncClient } from './client.js';
import { ExecSyncError } from './port.js';

/**
 * Потолок ожидания пробы — свой, много короче рабочего (`RDWEB_EXEC_TIMEOUT_MS`,
 * по умолчанию две минуты). Проба стоит за нажатой кнопкой: администратор,
 * которому две минуты показывают крутящийся индикатор, решит, что сломан
 * портал, а не связь. Прогону столько ждать не жалко, пробе — нельзя.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Идентификатор, которого не может существовать.
 *
 * Не случайный: проба обязана быть повторяемой и узнаваемой в чужом журнале —
 * администратор RD WEB, увидев её среди запросов, должен понимать, что это
 * проверка связи, а не сорвавшаяся отправка.
 */
const ABSENT_SYNC_ID = 'portal-id-connection-probe';

/** Шаг пробы. */
export type ExecProbeStepName = 'init' | 'read';

/** Вердикт шага: что именно чинить. */
export type ExecProbeOutcome =
  | 'ok'
  | 'unreachable'
  | 'credential'
  | 'scope'
  | 'project'
  | 'disabled'
  | 'rate_limited'
  | 'server'
  | 'unexpected';

export interface ExecProbeStep {
  readonly step: ExecProbeStepName;
  readonly outcome: ExecProbeOutcome;
  /** Код ответа RD WEB; `null`, когда ответа не было вовсе. */
  readonly status: number | null;
  /** Код контракта из тела ответа, если он там был. */
  readonly code: string | null;
  /** Вердикт словами: что это значит и что делать. */
  readonly message: string;
  /** Текст самой удалённой стороны. Удостоверение из него уже вычеркнуто. */
  readonly detail: string | null;
}

export interface ExecProbeResult {
  readonly ok: boolean;
  readonly steps: readonly ExecProbeStep[];
}

export interface ExecSyncProbe {
  /** Прогнать пробу. Не бросает: любой отказ — это её результат, а не сбой. */
  run(): Promise<ExecProbeResult>;
}

/**
 * Проба поверх готового клиента.
 *
 * Клиентом, а не адаптером: диагностика не входит в доменный контракт
 * синхронизации (`ExecSyncPort`), и её метод пришлось бы дописывать каждому
 * двойнику порта в тестах. Клиент при этом уже даёт всё нужное — Bearer,
 * сквозной `request_id`, измерение вызова и таймаут.
 */
export function execSyncProbe(client: ExecSyncClient, externalProjectId: string): ExecSyncProbe {
  return {
    async run(): Promise<ExecProbeResult> {
      const steps: ExecProbeStep[] = [];

      const init = await runStep('init', () =>
        client.request<unknown>({
          method: 'POST',
          path: '/document-syncs/init',
          operation: 'probe_init',
          body: { external_project_id: externalProjectId },
        }),
      );
      steps.push(init);
      // Останов на первой преграде: вторая, вызванная той же причиной, добавила
      // бы к диагнозу строку, но не смысл. Чинить всё равно надо первую.
      if (init.outcome !== 'ok') return { ok: false, steps };

      const read = await runStep('read', () =>
        client.request<unknown>({
          method: 'GET',
          path: `/document-syncs/${encodeURIComponent(ABSENT_SYNC_ID)}`,
          operation: 'probe_read',
        }),
      );
      steps.push(read);
      return { ok: read.outcome === 'ok', steps };
    },
  };
}

async function runStep(
  step: ExecProbeStepName,
  call: () => Promise<unknown>,
): Promise<ExecProbeStep> {
  try {
    await call();
    return {
      step,
      outcome: 'unexpected',
      status: null,
      code: null,
      message: UNEXPECTED_SUCCESS[step],
      detail: null,
    };
  } catch (error) {
    if (error instanceof ExecSyncError) return describeFailure(step, error);
    // Проба стоит за кнопкой администратора: неизвестный сбой обязан доехать до
    // экрана вердиктом, а не превратить диагностику в 500 без объяснения.
    return {
      step,
      outcome: 'unexpected',
      status: null,
      code: null,
      message: 'Проба сорвалась на стороне портала.',
      detail: error instanceof Error ? error.message : null,
    };
  }
}

const UNEXPECTED_SUCCESS: Readonly<Record<ExecProbeStepName, string>> = {
  init: 'RD WEB принял за снимок тело, снимком не являющееся: контур отвечает не по контракту.',
  read: 'RD WEB нашёл синхронизацию по идентификатору пробы, которой не может существовать.',
};

/** Что означает отказ и что с ним делать. */
function describeFailure(step: ExecProbeStepName, error: ExecSyncError): ExecProbeStep {
  const status = error.status ?? null;
  const code = error.code;
  const at = (outcome: ExecProbeOutcome, message: string): ExecProbeStep => ({
    step,
    outcome,
    status,
    code,
    message,
    detail: error.message,
  });

  if (status === null) {
    return at(
      'unreachable',
      'RD WEB не ответил: проверьте RDWEB_EXEC_BASE_URL и доступность узла из сети портала.',
    );
  }
  if (status === 401) {
    return at(
      'credential',
      'Удостоверение не признано. Оно не выпущено на этом экземпляре RD WEB, отозвано, просрочено — либо значение RDWEB_EXEC_TOKEN испорчено при копировании.',
    );
  }
  if (status === 403) {
    return code === 'project_forbidden'
      ? at(
          'project',
          'Удостоверение признано, но проект из RDWEB_EXEC_PROJECT_ID не входит в список разрешённых для него. Пустой список означает «ни одного проекта», а не «все».',
        )
      : at(
          'scope',
          'Удостоверение признано, но нужное право ему не выдано. Выпуск требует executive:sync:init, complete и read.',
        );
  }
  if (status === 404 && code === 'executive_disabled') {
    return at(
      'disabled',
      'Удостоверение признано, но контур исполнительной документации на стороне RD WEB выключен (executive.enabled).',
    );
  }
  if (status === 404 && code === 'sync_not_found') {
    return step === 'read'
      ? at('ok', 'Право на чтение результатов есть.')
      : at('unexpected', 'RD WEB ответил «синхронизация не найдена» на объявление снимка.');
  }
  if (status === 422) {
    return step === 'init'
      ? at(
          'ok',
          'Связь есть: удостоверение признано, проект разрешён, контур включён. Отправка снимка дошла до разбора манифеста.',
        )
      : at('unexpected', 'RD WEB отверг чтение как непригодный запрос.');
  }
  if (status === 429) {
    return at(
      'rate_limited',
      'RD WEB ограничил частоту запросов удостоверения. Связь при этом есть — повторите пробу позже.',
    );
  }
  if (status >= 500) {
    return at('server', 'RD WEB ответил ошибкой на своей стороне: связь есть, но сервис нездоров.');
  }
  return at('unexpected', 'RD WEB ответил кодом, которого проба не ожидала.');
}
