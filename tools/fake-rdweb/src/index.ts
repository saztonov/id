/**
 * Офлайн-двойник legacy-API RD WEB.
 *
 * ## Зачем он существует
 *
 * Портал ИД разговаривает с RD WEB по HTTP, а самого RD WEB на машине разработчика и
 * в CI нет. Мокать `fetch` внутри адаптера бессмысленно: так проверяется код мока, а
 * не соблюдение проводного контракта — коды ответов, форма тела, поведение поллинга и
 * оптимистичной блокировки. Поэтому двойник поднимает НАСТОЯЩИЙ HTTP-сервер на
 * случайном порту и отвечает ровно теми телами, что описаны в
 * `services/web_ocr/api/routes/*.py`.
 *
 * ## Границы
 *
 * Это не эмулятор RD WEB: распознавания, WebSocket-прогресса, провайдеров и админки
 * здесь нет. Есть ровно тот срез, который трогает портал, — вход, дерево, загрузка,
 * рендер, блоки, детекция, запуск и выгрузка.
 */
import Fastify, { type FastifyInstance } from 'fastify';

import { HttpError } from './errors.js';
import { registerAuthRoutes } from './routes-auth.js';
import { registerBlockRoutes } from './routes-blocks.js';
import { registerDocumentRoutes } from './routes-documents.js';
import { registerJobRoutes } from './routes-jobs.js';
import { registerProjectRoutes } from './routes-projects.js';
import {
  FakeState,
  type FakeRdWebCall,
  type FakeRdWebSnapshot,
  type FakeRecognitionFaults,
} from './state.js';

export type {
  BlockOut,
  BlockResultOut,
  BlockSourceName,
  BlockStatusName,
  BlockTypeName,
  DocumentCounters,
  DocumentSnapshot,
  DocumentStatusName,
  FakeRdWebCall,
  FakeRdWebSnapshot,
  FakeRecognitionFaults,
  JobOut,
  JobScopeName,
  JobSnapshot,
  JobStatusName,
  NodeSnapshot,
  NodeTypeName,
  PageOut,
  RenderStatusName,
  ShapeTypeName,
  TreeItemOut,
} from './state.js';
export { detectPage, detectPages, type DetectedBlock } from './detector.js';
export { countPdfPages, hasPdfMagic } from './pdf.js';

export interface FakeRdWebOptions {
  /** Служебные учётки: email → пароль. По умолчанию одна: portal@example.test. */
  readonly users?: ReadonlyArray<{ email: string; password: string }>;
  /** Через сколько обращений к `GET /api/documents/{id}` страницы становятся ready. */
  readonly renderDelayPolls?: number;
  /** Потолок страниц на один синхронный вызов detect-blocks. */
  readonly maxPagesPerDetectCall?: number;
  /** Сид детерминированного генератора блоков. */
  readonly seed?: string;
  /** TTL access-токена в секундах. */
  readonly accessTtlSec?: number;
}

export interface FakeRdWeb {
  /** Базовый адрес, например `http://127.0.0.1:53411`. */
  readonly url: string;
  /** Полный журнал принятых запросов — для проверки сквозного `x-request-id`. */
  readonly calls: readonly FakeRdWebCall[];
  /** Принудительный отказ следующего вызова эндпоинта (для проверки повторов). */
  failNext(pathFragment: string, status: number, detail?: string): void;
  /** Протухание всех выданных access-токенов: следующий вызов получит 401. */
  expireTokens(): void;
  /**
   * Включение запрограммированных отказов распознавания.
   *
   * Отдельно от `failNext`: тот моделирует ОДИН сбойный ответ, который адаптер
   * обязан пережить повтором, а эти четыре — устойчивые состояния внешней
   * системы, на которых проверяются не-деградируемые гейты §1.6.
   */
  setFaults(faults: Partial<FakeRecognitionFaults>): void;
  /** Снимок состояния для тестов (документы, блоки, узлы, job'ы) — только чтение. */
  snapshot(): FakeRdWebSnapshot;
  close(): Promise<void>;
}

const DEFAULT_USERS = [{ email: 'portal@example.test', password: 'portal-secret' }];
const DEFAULT_RENDER_DELAY_POLLS = 2;
const DEFAULT_MAX_PAGES_PER_DETECT_CALL = 10;
const DEFAULT_SEED = 'rd-web-fake';
const DEFAULT_ACCESS_TTL_SEC = 900;
/** Загрузка идёт телом PUT, поэтому потолок тела поднят под реальный PDF. */
const BODY_LIMIT_BYTES = 256 * 1024 * 1024;

function buildApp(state: FakeState, seed: string, baseUrl: () => string): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES });

  // Тело presigned PUT приходит с произвольным content-type (обычно application/pdf).
  // Без универсального парсера fastify ответил бы 415 раньше обработчика.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.addHook('onRequest', async (request, reply) => {
    const requestId = request.headers['x-request-id'];
    state.calls.push({
      seq: state.calls.length + 1,
      method: request.method,
      path: request.url,
      requestId: typeof requestId === 'string' ? requestId : null,
      at: new Date().toISOString(),
    });
    // Запрограммированный отказ срабатывает ДО аутентификации: он моделирует сбой
    // сети/сервиса, который адаптер обязан пережить повтором, а не отказ прав.
    const index = state.failures.findIndex((f) => request.url.includes(f.pathFragment));
    if (index >= 0) {
      const [failure] = state.failures.splice(index, 1);
      if (failure !== undefined) {
        await reply.code(failure.status).send({ detail: failure.detail });
      }
    }
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.status).send({ detail: error.detail });
    }
    // Всё прочее приводится к той же форме: клиент не должен видеть два разных
    // формата ошибки в зависимости от того, чей код упал.
    const fallback = error as { statusCode?: number; message?: string };
    const status = typeof fallback.statusCode === 'number' ? fallback.statusCode : 500;
    return reply.code(status).send({ detail: fallback.message ?? 'Внутренняя ошибка' });
  });

  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ detail: 'Not Found' }));

  registerAuthRoutes(app, state);
  registerProjectRoutes(app, state);
  registerDocumentRoutes(app, state, baseUrl);
  registerBlockRoutes(app, state, seed);
  registerJobRoutes(app, state, baseUrl);
  return app;
}

/** Поднять двойника на 127.0.0.1 со случайным свободным портом. */
export async function startFakeRdWeb(options: FakeRdWebOptions = {}): Promise<FakeRdWeb> {
  const state = new FakeState(
    options.renderDelayPolls ?? DEFAULT_RENDER_DELAY_POLLS,
    options.maxPagesPerDetectCall ?? DEFAULT_MAX_PAGES_PER_DETECT_CALL,
    options.accessTtlSec ?? DEFAULT_ACCESS_TTL_SEC,
  );
  for (const account of options.users ?? DEFAULT_USERS) {
    const email = account.email.toLowerCase();
    state.users.set(email, {
      userId: state.newId('usr'),
      email,
      password: account.password,
      systemRole: 'user',
    });
  }

  let url = '';
  const app = buildApp(state, options.seed ?? DEFAULT_SEED, () => url);
  // Порт 0 — обязательное условие многократного запуска в одном процессе: два
  // одновременных двойника с фиксированным портом просто не поднялись бы.
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  url = address;

  return {
    url,
    calls: state.calls,
    failNext(pathFragment: string, status: number, detail = 'Смоделированный отказ') {
      state.failures.push({ pathFragment, status, detail });
    },
    expireTokens() {
      state.tokenEpoch += 1;
    },
    setFaults(faults: Partial<FakeRecognitionFaults>) {
      Object.assign(state.faults, faults);
    },
    snapshot() {
      return state.snapshot();
    },
    async close() {
      await app.close();
    },
  };
}
