/**
 * Разбор ответов пробы связи: что именно узнаёт администратор, нажавший кнопку.
 *
 * Предмет теста — не «сходили и вернулись», а РАЗЛИЧЕНИЕ отказов. Все преграды
 * контура отвечают четырьмя-пятью кодами, и до пробы они сливались в один вид
 * «RD WEB ответил 4xx» посреди прогона распознавания. Чинить при этом надо
 * разное: выпустить удостоверение, добавить право, вписать проект в список,
 * включить контур, поправить адрес. Тест держит именно это соответствие.
 *
 * Отдельно проверяется договор о шагах: успех первого шага — это отказ `422`
 * (дойти до разбора манифеста можно, только пройдя все преграды разом), а `2xx`
 * на теле, которое снимком не является, — не успех, а неожиданность.
 */
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../../observability/logger.js';
import { createMetrics } from '../../observability/metrics.js';
import { ExecSyncClient } from './client.js';
import { execSyncProbe, type ExecProbeResult } from './probe.js';

const TOKEN = 'rdext-chasovoy-0002';
const PROJECT = 'idp-object-1';

/** Ответ на каждый вызов по порядку: объявление, чтение синхронизации, блоки. */
function runProbe(...responses: (() => Response)[]): Promise<ExecProbeResult> {
  const destination = new Writable({
    write(_chunk: Buffer, _encoding, callback) {
      callback();
    },
  });
  let call = 0;

  const client = new ExecSyncClient({
    baseUrl: 'https://rdweb.invalid',
    token: TOKEN,
    metrics: createMetrics({ enabled: false, service: 'exec-probe-test' }),
    logger: createLogger({ service: 'exec-probe-test', level: 'trace', destination }),
    slowExternalMs: 10_000,
    fetchImpl: (() => {
      const respond = responses[call];
      call += 1;
      if (respond === undefined) throw new Error('проба сделала больше вызовов, чем ожидалось');
      return Promise.resolve(respond());
    }) as typeof fetch,
  });

  return execSyncProbe(client, PROJECT).run();
}

/** Отказ в форме контракта §10. */
function detail(status: number, code: string, message: string): () => Response {
  return () =>
    new Response(JSON.stringify({ detail: { code, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

describe('проба различает преграды контура', () => {
  it('422 на объявлении снимка и два 404 на чтении — связь есть', async () => {
    const result = await runProbe(
      detail(422, 'invalid_manifest', 'Манифест не разобран'),
      detail(404, 'sync_not_found', 'Синхронизация не найдена'),
      detail(404, 'document_not_found', 'Документ не зарегистрирован'),
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => [step.step, step.outcome])).toEqual([
      ['init', 'ok'],
      ['read', 'ok'],
      ['blocks', 'ok'],
    ]);
  });

  it('401 читается как непризнанное удостоверение и называет причины', async () => {
    const result = await runProbe(detail(401, 'invalid_principal', 'Удостоверение не признано'));

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ outcome: 'credential', status: 401 });
    expect(result.steps[0]?.message).toContain('RDWEB_EXEC_TOKEN');
    // Текст удалённой стороны доезжает: без него «не признано» и «сломан их
    // обработчик» выглядят одинаково.
    expect(result.steps[0]?.detail).toContain('Удостоверение не признано');
  });

  it('403 разделён на «нет права» и «чужой проект»: чинится это по-разному', async () => {
    const scope = await runProbe(detail(403, 'scope_forbidden', 'Права нет'));
    expect(scope.steps[0]).toMatchObject({ outcome: 'scope' });
    expect(scope.steps[0]?.message).toContain('executive:sync:init');

    const project = await runProbe(detail(403, 'project_forbidden', 'Проект чужой'));
    expect(project.steps[0]).toMatchObject({ outcome: 'project' });
    expect(project.steps[0]?.message).toContain('RDWEB_EXEC_PROJECT_ID');
  });

  it('404 executive_disabled — это выключенный контур, а не отсутствие маршрута', async () => {
    const result = await runProbe(detail(404, 'executive_disabled', 'Контур не выкачен'));

    expect(result.steps[0]).toMatchObject({
      outcome: 'disabled',
      status: 404,
      code: 'executive_disabled',
    });
    expect(result.steps[0]?.message).toContain('executive.enabled');
  });

  it('429 и 5xx не выдаются за обрыв связи: связь есть, мешает другое', async () => {
    const limited = await runProbe(detail(429, 'rate_limited', 'Слишком часто'));
    expect(limited.steps[0]).toMatchObject({ outcome: 'rate_limited' });

    const broken = await runProbe(() => new Response('Internal Server Error', { status: 500 }));
    expect(broken.steps[0]).toMatchObject({ outcome: 'server', status: 500 });
  });

  it('несостоявшийся вызов назван недоступностью адреса', async () => {
    const result = await runProbe(() => {
      throw new TypeError('fetch failed');
    });

    expect(result.steps[0]).toMatchObject({ outcome: 'unreachable', status: null, code: null });
    expect(result.steps[0]?.message).toContain('RDWEB_EXEC_BASE_URL');
  });
});

describe('проба не выдаёт неожиданное за успех', () => {
  it('принятый «снимок» из тела, снимком не являющегося, — неожиданность', async () => {
    const result = await runProbe(
      () =>
        new Response(JSON.stringify({ sync_id: 'eds-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ outcome: 'unexpected' });
  });

  it('останавливается на первой преграде и следующих шагов не делает', async () => {
    // Второй ответ не задан намеренно: обращение за ним обрушило бы стенд, и
    // это и есть проверка того, что шага не было.
    const result = await runProbe(detail(401, 'invalid_principal', 'Удостоверение не признано'));

    expect(result.steps).toHaveLength(1);
  });
});

/**
 * Дефект, ради которого шаг `blocks` и появился: связь была, удостоверение
 * признано, проект разрешён — и прогон всё равно падал, потому что
 * единственный путь, по которому он забирает результаты, не сопоставлялся с
 * маршрутом на той стороне. Двухшаговая проба этого не видела вовсе.
 */
describe('маршрут результатов проверяется отдельно от маршрута синхронизаций', () => {
  const passedFirstTwo = [
    detail(422, 'invalid_manifest', 'Манифест не разобран'),
    detail(404, 'sync_not_found', 'Синхронизация не найдена'),
  ] as const;

  it('«маршрута нет» на чтении блоков не выдаётся за отсутствие документа', async () => {
    const result = await runProbe(...passedFirstTwo, detail(404, 'not_found', 'Request rejected'));

    expect(result.ok).toBe(false);
    expect(result.steps[2]).toMatchObject({ step: 'blocks', outcome: 'unexpected', status: 404 });
    expect(result.steps[2]?.message).toContain('GET /documents/{id}/blocks');
    expect(result.steps[2]?.message).toContain('RDWEB_EXEC_BASE_URL');
  });

  it('404 без кода вовсе разбирается так же: тело отказа могло и не дойти', async () => {
    const result = await runProbe(...passedFirstTwo, () => new Response('', { status: 404 }));

    expect(result.steps[2]).toMatchObject({ outcome: 'unexpected', status: 404 });
    expect(result.steps[2]?.message).toContain('маршрут');
  });

  it('«документа нет» на чтении синхронизации — тоже неожиданность, а не успех', async () => {
    const result = await runProbe(
      detail(422, 'invalid_manifest', 'Манифест не разобран'),
      detail(404, 'document_not_found', 'Документ не зарегистрирован'),
    );

    expect(result.ok).toBe(false);
    expect(result.steps[1]).toMatchObject({ step: 'read', outcome: 'unexpected' });
  });

  it('отданные результаты несуществующего документа — неожиданность, а не успех', async () => {
    const result = await runProbe(
      ...passedFirstTwo,
      () =>
        new Response(JSON.stringify({ items: [], next_cursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    expect(result.ok).toBe(false);
    expect(result.steps[2]).toMatchObject({ step: 'blocks', outcome: 'unexpected' });
  });
});
