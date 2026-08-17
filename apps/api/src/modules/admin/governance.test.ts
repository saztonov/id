/**
 * Конечный автомат состояний промта и версии набора правил (§10, §3.7).
 *
 * Проверяется чистая логика: ни БД, ни Fastify. Это не удобство прогона, а
 * требование к самому автомату — экран администрирования гасит кнопки
 * недопустимых переходов ДО запроса, значит набор переходов обязан быть
 * вычислимым без базы. Тесты HTTP и триггеров живут в `admin.test.ts`.
 *
 * Проверки идут двумя слоями. Точечные — на конкретных парах состояний из §10.
 * Свойственные — на полном перекрёстном произведении состояний: они ловят не
 * забытый случай, а рассогласование автомата с самим собой. Именно такое
 * рассогласование опасно: `allowedTransitions()` рисует интерфейс, а
 * `evaluateTransition()` пропускает запись, и разъехаться они могут молча.
 *
 * Одно расхождение с формулировкой задания оговаривается прямо. Переход
 * `archived → published` в задании назван запрещённым, но там же требуется
 * допустимость отката на прежнюю опубликованную версию. У промта это ОДНА И ТА
 * ЖЕ операция: прежняя версия лежит в `archived`, и вернуть её в работу можно
 * только публикацией. Запрет сделал бы откат невыполнимым, поэтому у промта
 * переход разрешён и обязан иметь вид `rollback` (а правка архивной версии при
 * этом запрещена — иначе «прежняя версия» вернулась бы с другим текстом). У
 * версии набора правил состояния `archived` нет вовсе, и там та же пара
 * состояний обязана отвергаться. Проверяется и то, и другое.
 */
import { describe, expect, it } from 'vitest';

import {
  allowedTransitions,
  editableStates,
  evaluateContentEdit,
  evaluateTransition,
  rollbackMechanism,
  statesOf,
  supportsState,
  type EditDenied,
  type GovernanceState,
  type GovernedEntity,
  type TransitionAllowed,
  type TransitionDenied,
} from './governance.js';

const ALL_STATES: readonly GovernanceState[] = ['draft', 'test', 'published', 'archived'];
const ENTITIES: readonly GovernedEntity[] = ['prompt', 'ruleset'];

/**
 * Отказ с сужением типа.
 *
 * Через `expect` до `throw`, чтобы в отчёте была осмысленная строка, а не
 * необработанное исключение: сообщение обязано называть пару состояний, иначе
 * при падении неясно, какая из тридцати двух пар сломалась.
 */
function denialOf(
  entity: GovernedEntity,
  from: GovernanceState,
  to: GovernanceState,
): TransitionDenied {
  const verdict = evaluateTransition(entity, from, to);
  expect(verdict.allowed, `«${entity}»: ${from} → ${to} ожидался как отказ`).toBe(false);
  if (verdict.allowed) throw new Error('недостижимо: проверка выше уже провалилась');
  return verdict;
}

function permissionOf(
  entity: GovernedEntity,
  from: GovernanceState,
  to: GovernanceState,
): TransitionAllowed {
  const verdict = evaluateTransition(entity, from, to);
  expect(verdict.allowed, `«${entity}»: ${from} → ${to} ожидался как разрешённый`).toBe(true);
  if (!verdict.allowed) throw new Error('недостижимо: проверка выше уже провалилась');
  return verdict;
}

function editDenialOf(entity: GovernedEntity, state: GovernanceState): EditDenied {
  const verdict = evaluateContentEdit(entity, state);
  expect(verdict.allowed, `«${entity}»: правка в состоянии ${state} ожидалась запрещённой`).toBe(
    false,
  );
  if (verdict.allowed) throw new Error('недостижимо: проверка выше уже провалилась');
  return verdict;
}

/** Длины путей от состояния по разрешённым переходам. Ключ отсутствует — недостижимо. */
function distancesFrom(
  entity: GovernedEntity,
  start: GovernanceState,
): ReadonlyMap<GovernanceState, number> {
  const distance = new Map<GovernanceState, number>([[start, 0]]);
  const queue: GovernanceState[] = [start];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    const step = distance.get(current) ?? 0;
    for (const next of allowedTransitions(entity, current)) {
      if (distance.has(next)) continue;
      distance.set(next, step + 1);
      queue.push(next);
    }
  }

  return distance;
}

// =====================================================================
// Множества состояний
// =====================================================================

describe('состояния и их принадлежность сущности', () => {
  it('у промта четыре состояния, у версии набора правил два', () => {
    expect(statesOf('prompt')).toEqual(['draft', 'test', 'published', 'archived']);
    expect(statesOf('ruleset')).toEqual(['draft', 'published']);
  });

  it('supportsState согласован с statesOf на всех состояниях', () => {
    for (const entity of ENTITIES) {
      for (const state of ALL_STATES) {
        expect({ entity, state, supported: supportsState(entity, state) }).toEqual({
          entity,
          state,
          supported: statesOf(entity).includes(state),
        });
      }
    }
  });

  it('правятся только draft и test, и только из числа состояний сущности', () => {
    expect(editableStates('prompt')).toEqual(['draft', 'test']);
    // У версии набора правил нет `test`, поэтому список короче сам, а не по
    // отдельному правилу: правится только черновик.
    expect(editableStates('ruleset')).toEqual(['draft']);

    for (const entity of ENTITIES) {
      for (const state of editableStates(entity)) {
        expect(supportsState(entity, state)).toBe(true);
      }
    }
  });

  it('механизм отката различается по сущности и следует из наличия archived', () => {
    expect(rollbackMechanism('prompt')).toBe('republish_previous_version');
    expect(rollbackMechanism('ruleset')).toBe('switch_active_pointer');

    // Связь не декоративная: «вернуть прежнюю версию публикацией» возможно
    // только там, где прежняя версия хранится в неактивном состоянии.
    expect(supportsState('prompt', 'archived')).toBe(true);
    expect(supportsState('ruleset', 'archived')).toBe(false);
  });
});

// =====================================================================
// Допустимый жизненный путь
// =====================================================================

describe('промт: draft → test → published → archived', () => {
  it('каждый шаг пути разрешён и имеет свой смысл', () => {
    expect(permissionOf('prompt', 'draft', 'test').kind).toBe('promote');
    expect(permissionOf('prompt', 'test', 'published').kind).toBe('publish');
    expect(permissionOf('prompt', 'published', 'archived').kind).toBe('archive');
  });

  it('публикация ставит отметку и архивирует прежнюю опубликованную версию', () => {
    // Архивация прежней — не удобство: `ux_prompt_templates_single_published`
    // допускает одну опубликованную версию на код, поэтому публикация без неё
    // упала бы на уникальном индексе.
    expect(permissionOf('prompt', 'test', 'published').effects).toEqual({
      archivesPreviousPublished: true,
      stampsPublication: true,
    });
  });

  it('перевод в test обратим: черновик после dry-run можно доработать', () => {
    expect(permissionOf('prompt', 'test', 'draft').kind).toBe('demote');
  });

  it('снять с эксплуатации можно из любого рабочего состояния', () => {
    for (const from of ['draft', 'test', 'published'] as const) {
      expect(permissionOf('prompt', from, 'archived').kind).toBe('archive');
    }
  });

  it('архивация не выдаёт себя за публикацию', () => {
    expect(permissionOf('prompt', 'published', 'archived').effects).toEqual({
      archivesPreviousPublished: false,
      stampsPublication: false,
    });
  });

  it('все состояния промта достижимы из черновика', () => {
    const reachable = distancesFrom('prompt', 'draft');
    for (const state of statesOf('prompt')) {
      expect({ state, reachable: reachable.has(state) }).toEqual({ state, reachable: true });
    }
  });
});

describe('версия набора правил: draft → published и всё', () => {
  it('публикация разрешена и ставит отметку, но ничего не архивирует', () => {
    const verdict = permissionOf('ruleset', 'draft', 'published');
    expect(verdict.kind).toBe('publish');
    // Прежняя версия остаётся опубликованной навсегда: на неё ссылаются
    // выполненные прогоны проверок, и «архивировать» её значило бы изменить
    // строку, которую триггер 0008 менять не даёт.
    expect(verdict.effects).toEqual({
      archivesPreviousPublished: false,
      stampsPublication: true,
    });
  });

  it('published терминально: выйти из него нельзя ни одним переходом', () => {
    expect(allowedTransitions('ruleset', 'published')).toEqual([]);
  });

  it('никакая пара состояний не ведёт обратно к правке набора', () => {
    const reachable = distancesFrom('ruleset', 'published');
    expect([...reachable.keys()]).toEqual(['published']);
  });
});

// =====================================================================
// Запрещённые переходы: отказ обязан объяснять
// =====================================================================

describe('запрещённые переходы отвергаются с объяснением', () => {
  it('published → draft: опубликованное неизменяемо, исправление — новая версия', () => {
    const verdict = denialOf('prompt', 'published', 'draft');
    expect(verdict.code).toBe('published-immutable');
    expect(verdict.explanation).toContain('неизменяем');
    // Объяснение обязано называть выход, а не только запрет: без этого
    // администратор упирается в тупик на юридически значимой операции.
    expect(verdict.explanation).toContain('новой версией');
    expect(verdict.explanation).toContain('откат');
  });

  it('published → test: возврат в стадию проверки — тот же запрет', () => {
    const verdict = denialOf('prompt', 'published', 'test');
    expect(verdict.code).toBe('published-immutable');
    expect(verdict.explanation).toContain('неизменяем');
  });

  it('archived → draft и archived → test: из архива черновик не делают', () => {
    for (const to of ['draft', 'test'] as const) {
      const verdict = denialOf('prompt', 'archived', to);
      expect(verdict.code).toBe('archived-content-frozen');
      expect(verdict.explanation).toContain('новую версию');
    }
  });

  it('draft → published: стадия test обязательна и названа в отказе', () => {
    const verdict = denialOf('prompt', 'draft', 'published');
    expect(verdict.code).toBe('requires-test-stage');
    expect(verdict.explanation).toContain('test');
    expect(verdict.explanation).toContain('dry-run');
  });

  it('стадия test обязательна структурно, а не только текстом отказа', () => {
    // Кратчайший путь из черновика в публикацию — два шага. Если однажды
    // появится прямой переход, эта проверка упадёт раньше, чем «отказ содержит
    // слово test» перестанет что-либо значить.
    expect(distancesFrom('prompt', 'draft').get('published')).toBe(2);
    expect(allowedTransitions('prompt', 'draft')).not.toContain('published');
  });

  it('переход в то же состояние — не отказ по правилам, а отсутствие действия', () => {
    for (const entity of ENTITIES) {
      for (const state of statesOf(entity)) {
        const verdict = denialOf(entity, state, state);
        expect(verdict.code).toBe('no-op');
      }
    }
  });

  it('archived → published у версии набора правил отвергается: такого состояния нет', () => {
    const verdict = denialOf('ruleset', 'archived', 'published');
    expect(verdict.code).toBe('state-not-supported');
    // Отказ обязан назвать настоящий механизм смены действующего набора,
    // иначе администратор будет искать несуществующую кнопку «разархивировать».
    expect(verdict.explanation).toContain('переключением активной версии');
  });

  it('у версии набора правил нет ни test, ни archived', () => {
    for (const state of ['test', 'archived'] as const) {
      expect(denialOf('ruleset', 'draft', state).code).toBe('state-not-supported');
      expect(denialOf('ruleset', state, 'published').code).toBe('state-not-supported');
    }
  });

  it('published → draft у версии набора правил объясняется воспроизводимостью прогонов', () => {
    const verdict = denialOf('ruleset', 'published', 'draft');
    expect(verdict.code).toBe('published-immutable');
    expect(verdict.explanation).toContain('прогоны проверок');
    expect(verdict.explanation).toContain('переключение');
  });

  it('объяснение опубликованного различается по сущности, а не берётся общим', () => {
    // У промта причина — посчитанные ответы модели, у набора правил —
    // воспроизводимость прогона. Общий текст скрыл бы от администратора, чем
    // именно он рискует.
    const prompt = denialOf('prompt', 'published', 'draft').explanation;
    const ruleset = denialOf('ruleset', 'published', 'draft').explanation;
    expect(prompt).not.toBe(ruleset);
    expect(prompt).toContain('модели');
    expect(ruleset).toContain('прогон');
  });
});

// =====================================================================
// Откат
// =====================================================================

describe('откат: прежняя версия возвращается, но не правится', () => {
  it('переключение на прежнюю опубликованную версию промта допустимо', () => {
    const verdict = permissionOf('prompt', 'archived', 'published');
    expect(verdict.kind).toBe('rollback');
    // Отметка публикации ставится заново — это «с каких пор версия действует»;
    // действующая версия при этом уходит в архив, иначе их станет две.
    expect(verdict.effects).toEqual({
      archivesPreviousPublished: true,
      stampsPublication: true,
    });
  });

  it('правка архивной версии запрещена: иначе откат вернул бы другой текст', () => {
    const verdict = editDenialOf('prompt', 'archived');
    expect(verdict.code).toBe('archived-content-frozen');
    expect(verdict.explanation).toContain('откат');
  });

  it('откат — единственный выход из архива', () => {
    expect(allowedTransitions('prompt', 'archived')).toEqual(['published']);
  });

  it('у набора правил откат вообще не является переходом состояния', () => {
    // Ни одна пара состояний набора не даёт `rollback`: возврат прежних правил
    // выполняется переключением указателя действующей версии.
    for (const from of statesOf('ruleset')) {
      for (const to of statesOf('ruleset')) {
        const verdict = evaluateTransition('ruleset', from, to);
        if (verdict.allowed) expect(verdict.kind).not.toBe('rollback');
      }
    }
    expect(rollbackMechanism('ruleset')).toBe('switch_active_pointer');
  });
});

// =====================================================================
// Правка содержимого
// =====================================================================

describe('правка содержимого разрешена ровно в редактируемых состояниях', () => {
  it('согласие на правку совпадает с editableStates на всех состояниях', () => {
    for (const entity of ENTITIES) {
      for (const state of ALL_STATES) {
        const allowed = evaluateContentEdit(entity, state).allowed;
        expect({ entity, state, allowed }).toEqual({
          entity,
          state,
          allowed: editableStates(entity).includes(state),
        });
      }
    }
  });

  it('правка опубликованного отвергается кодом published-immutable у обеих сущностей', () => {
    for (const entity of ENTITIES) {
      expect(editDenialOf(entity, 'published').code).toBe('published-immutable');
    }
  });

  it('состояние чужой сущности отвергается отдельным кодом, а не «нельзя править»', () => {
    // Различие важно вызывающему: `state-not-supported` — это ошибка запроса
    // (422), а `published-immutable` — конфликт состояния (409).
    for (const state of ['test', 'archived'] as const) {
      expect(editDenialOf('ruleset', state).code).toBe('state-not-supported');
    }
  });
});

// =====================================================================
// Свойства автомата в целом
// =====================================================================

describe('автомат согласован сам с собой на всех парах состояний', () => {
  it('allowedTransitions перечисляет ровно то, что пропускает evaluateTransition', () => {
    for (const entity of ENTITIES) {
      for (const from of ALL_STATES) {
        const listed = [...allowedTransitions(entity, from)].sort();
        const accepted = ALL_STATES.filter(
          (to) => from !== to && evaluateTransition(entity, from, to).allowed,
        ).sort();
        expect({ entity, from, listed }).toEqual({ entity, from, listed: accepted });
      }
    }
  });

  it('перечисленный переход не ведёт в состояние чужой сущности', () => {
    for (const entity of ENTITIES) {
      for (const from of ALL_STATES) {
        for (const to of allowedTransitions(entity, from)) {
          expect({ entity, from, to, supported: supportsState(entity, to) }).toEqual({
            entity,
            from,
            to,
            supported: true,
          });
        }
      }
    }
  });

  it('каждый отказ объясняет причину текстом, пригодным для показа', () => {
    for (const entity of ENTITIES) {
      for (const from of ALL_STATES) {
        for (const to of ALL_STATES) {
          const verdict = evaluateTransition(entity, from, to);
          if (verdict.allowed) continue;
          // Пустая строка и «нельзя» — это отказ без объяснения: в интерфейсе
          // он выглядит как поломка, а в поддержке — как загадка.
          expect({ entity, from, to, length: verdict.explanation.length > 20 }).toEqual({
            entity,
            from,
            to,
            length: true,
          });
          expect(verdict.explanation).toMatch(/[.:]$|[.:]\s*$/);
        }
      }
    }
  });

  it('из published содержимое не оживает ни одним путём, а не только одним шагом', () => {
    // Главный инвариант §3.9: опубликованное неизменяемо. Проверять его по
    // отдельным парам недостаточно — запрет обошёлся бы обходным путём
    // published → archived → draft, если бы такой появился.
    for (const entity of ENTITIES) {
      const reachable = distancesFrom(entity, 'published');
      for (const state of editableStates(entity)) {
        expect({ entity, state, reachable: reachable.has(state) }).toEqual({
          entity,
          state,
          reachable: false,
        });
      }
    }
  });

  it('отметка публикации ставится ровно при переходе в published', () => {
    for (const entity of ENTITIES) {
      for (const from of ALL_STATES) {
        for (const to of ALL_STATES) {
          const verdict = evaluateTransition(entity, from, to);
          if (!verdict.allowed) continue;
          expect({ entity, from, to, stamps: verdict.effects.stampsPublication }).toEqual({
            entity,
            from,
            to,
            stamps: to === 'published',
          });
        }
      }
    }
  });

  it('архивация прежней версии требуется только промту и только на публикации', () => {
    for (const entity of ENTITIES) {
      for (const from of ALL_STATES) {
        for (const to of ALL_STATES) {
          const verdict = evaluateTransition(entity, from, to);
          if (!verdict.allowed) continue;
          expect({
            entity,
            from,
            to,
            archives: verdict.effects.archivesPreviousPublished,
          }).toEqual({
            entity,
            from,
            to,
            archives: entity === 'prompt' && to === 'published',
          });
        }
      }
    }
  });

  it('состояние чужой сущности отвергается раньше разбора пары', () => {
    // Порядок проверок значим: иначе `ruleset: archived → archived` получил бы
    // `no-op` и выглядел бы как «уже в этом состоянии», хотя состояния нет.
    for (const state of ['test', 'archived'] as const) {
      expect(denialOf('ruleset', state, state).code).toBe('state-not-supported');
    }
  });
});
