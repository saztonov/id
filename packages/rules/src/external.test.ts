/**
 * Шов внешних реестров: провайдер → снимок (§9.5).
 *
 * Правила `EXT.*` и `DATE.332` сняты в S59 (ADR-0029), и тесты «снимок доходит
 * до вердикта правила» ушли вместе с ними — доводить снимок больше некуда.
 * Сама сборка (`resolveExternalRegistries`) остаётся: её читают воркер и
 * `testing.ts`, а её договор — «отказ провайдера гасится, а не роняет прогон»
 * — не зависит от того, кто потребляет снимок.
 *
 * Отрицательный и положительный пути идут ОДНОЙ дорогой и различаются только
 * набором провайдеров.
 */
import { describe, expect, it } from 'vitest';

import {
  createInternalRegistryProviders,
  createManualProvider,
  NO_SOURCE_REASON,
  resolveExternalRegistries,
  type ExternalRegistryProviders,
  type RegistryQuery,
} from './external.js';
import type { ScheduleRecord } from './types.js';

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

  it('ручной источник отдаёт свои записи, не делая доступными остальные реестры', async () => {
    // Провайдеры независимы: подключённый график не имеет права молча закрыть
    // вопрос о СРО.
    const snapshot = await resolveExternalRegistries(withManualSchedule(PLANNED), QUERY);
    expect(snapshot.schedule.status).toBe('available');
    expect(snapshot.schedule.status === 'available' ? snapshot.schedule.records : []).toEqual(
      PLANNED,
    );
    expect(snapshot.sro.status).toBe('unavailable');
    expect(snapshot.nrs.status).toBe('unavailable');
    expect(snapshot.accreditation.status).toBe('unavailable');
  });
});
