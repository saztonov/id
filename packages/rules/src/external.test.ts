/**
 * Шов внешних реестров: провайдер → снимок → вердикт правила (§9.5).
 *
 * `aosr.test.ts` проверяет ПРАВИЛА при доступном источнике, подставляя
 * `graph.external` руками. Здесь проверяется то, что при такой подстановке не
 * исполняется вовсе, — сама сборка снимка: `resolveExternalRegistries` опрашивает
 * провайдеров, гасит их отказы и отдаёт результат, который правило читает как
 * чистая функция. Между «правило умеет читать снимок» и «сборка приносит ему
 * снимок» ровно тот зазор, в котором на S3 жил написанный, но не подключённый
 * слой наблюдаемости: обе половины были зелёными, конвейер — нет.
 *
 * Отрицательный и положительный пути идут ОДНОЙ дорогой и различаются только
 * набором провайдеров: комплект, разметка и правило те же.
 */
import { describe, expect, it } from 'vitest';

import { EXTERNAL_RULES } from './aosr.js';
import {
  createInternalRegistryProviders,
  createManualProvider,
  NO_SOURCE_REASON,
  resolveExternalRegistries,
  type ExternalRegistryProviders,
  type RegistryQuery,
} from './external.js';
import { makeDocument, makeField, makeGraph } from './testing.js';
import type { CheckGraph, RuleResult, ScheduleRecord } from './types.js';

const WORK = 'Устройство 2 слоя гидроизоляции кровли';

const QUERY: RegistryQuery = {
  objectId: 'obj-1',
  contractorId: 'cp-1',
  inns: ['7700123459'],
  people: ['Иванов Иван Иванович'],
  accreditationNumbers: [],
  onDates: ['2026-03-09'],
};

const PLANNED: readonly ScheduleRecord[] = [
  { workName: WORK, plannedFrom: '2026-02-20', plannedTo: '2026-03-15' },
];

function actGraph(): CheckGraph {
  return makeGraph({
    documents: [
      makeDocument({
        id: 'act-1',
        docTypeCode: 'aosr',
        fields: [
          makeField({ fieldCode: 'act_number', valueText: '336' }),
          makeField({ fieldCode: 'work_name', valueText: WORK }),
        ],
      }),
    ],
  });
}

function schedule(rule: string, graph: CheckGraph): RuleResult {
  const spec = EXTERNAL_RULES.find((item) => item.code === rule);
  if (spec === undefined) throw new Error(`правило ${rule} отсутствует в группе внешних`);
  return spec.evaluate(graph, spec.defaultParams);
}

/** Провайдеры, у которых доступен только график: остальные — штатный MVP. */
function withManualSchedule(records: readonly ScheduleRecord[]): ExternalRegistryProviders {
  return { ...createInternalRegistryProviders(), schedule: createManualProvider(records) };
}

describe('resolveExternalRegistries: провайдеры MVP', () => {
  it('без источников все четыре ответа — unavailable с одной причиной', async () => {
    const snapshot = await resolveExternalRegistries(createInternalRegistryProviders(), QUERY);
    for (const lookup of [snapshot.nrs, snapshot.sro, snapshot.accreditation, snapshot.schedule]) {
      expect(lookup.status).toBe('unavailable');
      expect(lookup.status === 'unavailable' ? lookup.reason : '').toBe(NO_SOURCE_REASON);
    }
  });

  it('упавший провайдер превращается в unavailable, а не роняет прогон', async () => {
    // Комплект обязан быть проверен до конца: отказ реестра — это состояние
    // `external_unavailable`, а не исключение посреди задачи 20.
    const providers: ExternalRegistryProviders = {
      ...createInternalRegistryProviders(),
      nrs: {
        name: 'broken',
        lookupSpecialists: () => Promise.reject(new Error('таймаут')),
      },
    };
    const snapshot = await resolveExternalRegistries(providers, QUERY);
    expect(snapshot.nrs.status).toBe('unavailable');
    expect(snapshot.nrs.status === 'unavailable' ? snapshot.nrs.reason : '').toContain('таймаут');
    // Соседние реестры отвечают своё: один отказ не обнуляет остальные.
    expect(snapshot.sro.status).toBe('unavailable');
  });
});

describe('снимок из провайдеров доходит до вердикта правила', () => {
  it('без источника EXT.SCHED.142 даёт external_unavailable', async () => {
    const external = await resolveExternalRegistries(createInternalRegistryProviders(), QUERY);
    const result = schedule('EXT.SCHED.142', { ...actGraph(), external });

    expect(result.verdict).toBe('undetermined');
    expect(result.findings?.[0]?.origin).toBe('external_unavailable');
    expect(result.findings?.[0]?.message).toContain('требуется ручная проверка');
  });

  it('с ручным источником EXT.SCHED.142 перестаёт выдавать external_unavailable', async () => {
    const external = await resolveExternalRegistries(withManualSchedule(PLANNED), QUERY);
    const result = schedule('EXT.SCHED.142', { ...actGraph(), external });

    expect(result.verdict).toBe('pass');
    expect(result.findings ?? []).toHaveLength(0);
  });

  it('ручной источник без нужной записи даёт fail, а не «недоступно»', async () => {
    // Отличие существенное: «источника нет» — не вывод о работах, а «работ нет
    // в графике» — вывод. Один шов обязан приводить к обоим, иначе доступность
    // источника ничего не меняет.
    const other: readonly ScheduleRecord[] = [
      { workName: 'Монтаж металлоконструкций', plannedFrom: null, plannedTo: null },
    ];
    const external = await resolveExternalRegistries(withManualSchedule(other), QUERY);
    const result = schedule('EXT.SCHED.142', { ...actGraph(), external });

    expect(result.verdict).toBe('fail');
    expect(result.findings?.[0]?.origin).toBe('deterministic');
    expect(result.findings?.[0]?.message).toContain(WORK);
  });

  it('доступность графика не делает доступными остальные реестры', async () => {
    // Провайдеры независимы: подключённый график не имеет права молча закрыть
    // вопрос о СРО.
    const external = await resolveExternalRegistries(withManualSchedule(PLANNED), QUERY);
    const result = schedule('EXT.SRO.140', { ...actGraph(), external });

    expect(result.findings?.[0]?.origin).toBe('external_unavailable');
  });
});
