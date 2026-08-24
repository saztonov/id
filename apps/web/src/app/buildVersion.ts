/**
 * Идентификатор сборки и правило сверки версий.
 *
 * Одна метка на выкатку — `APP_RELEASE`, — и у неё два потребителя: журнал
 * ошибок браузера (§11, ADR-0010) и плашка «доступна новая версия»
 * (`AppUpdateBanner`). Модуль отдельный именно поэтому: два объявления одного
 * глобала разошлись бы в трактовке пустого значения, а сравнивать вкладке было
 * бы не с чем.
 */

declare const __BUILD_ID__: string | undefined;

/**
 * Идентификатор сборки.
 *
 * Подставляется сборщиком; в dev-режиме его нет, и это честное `undefined`, а
 * не выдуманное значение: строка «dev» в ряде по релизам смешала бы машины
 * разработчиков с боевой установкой.
 */
export const BUILD_ID: string | undefined =
  typeof __BUILD_ID__ === 'string' && __BUILD_ID__ !== '' ? __BUILD_ID__ : undefined;

/**
 * Опубликована ли сборка, отличная от той, на которой работает вкладка.
 *
 * Ответ `true` требует ДВУХ непустых меток. Сборка без `APP_RELEASE` (dev,
 * ручной `vite build`) не названа, и сравнивать её не с чем: молчание здесь
 * честнее плашки, которая предлагала бы перезагрузку без всякого повода.
 *
 * Неизвестная форма ответа — тоже `false`, а не ошибка: `version.json` читается
 * с раздачи статики, и на месте JSON может оказаться страница-заглушка прокси
 * или обрезанный ответ. Вкладка от этого не должна ни падать, ни звать человека.
 */
export function isOutdatedBuild(current: string | undefined, published: unknown): boolean {
  if (current === undefined || current === '') return false;
  if (typeof published !== 'object' || published === null) return false;

  const buildId: unknown = (published as { buildId?: unknown }).buildId;
  if (typeof buildId !== 'string' || buildId === '') return false;

  return buildId !== current;
}
