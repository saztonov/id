/**
 * Ошибки полей из `problem+json` 422 → подсветка полей формы (§14).
 *
 * Сервер отвечает на нарушение бизнес-правила не строкой, а списком
 * `errors: [{ pointer, code, message }]` — JSON Pointer на поле тела запроса.
 * Свернуть этот список в одно уведомление значит потерять именно ту часть
 * ответа, ради которой он и формируется: какое поле неверно. Пользователь
 * получал бы «Профиль ссылается на коды, которых нет в справочниках» и должен
 * был бы сам угадывать, в каком из трёх мультиселектов опечатка.
 *
 * ## Ни одно сообщение не пропадает
 *
 * Указатель может не соответствовать ни одному полю формы: сервер знает про
 * поля тела запроса, а форма — про свои элементы, и они совпадают не всегда
 * (`/to` у перехода состояния промта, `/rules` у снимка набора). Такие
 * сообщения возвращаются отдельным списком, а не отбрасываются: молча
 * проглоченное объяснение отказа — это отказ без объяснения.
 */
import type { FormInstance } from 'antd';
import { isApiError } from '../api/problem.js';

/** Путь к полю формы в терминах antd (`name` элемента `Form.Item`). */
export type FieldPath = (string | number)[];

export interface FieldErrorEntry {
  readonly name: FieldPath;
  readonly errors: string[];
}

export interface MappedFieldErrors {
  /** Готово для `form.setFields(...)`. */
  readonly fields: FieldErrorEntry[];
  /** Сообщения, которым не нашлось поля: показываются отдельным блоком. */
  readonly unmatched: string[];
}

/**
 * Разбор JSON Pointer в путь antd.
 *
 * `/rules/0/severity` → `['rules', 0, 'severity']`. Экранирование RFC 6901
 * (`~1` — косая черта, `~0` — тильда) разворачивается в том же порядке, что в
 * стандарте: сначала `~1`, потом `~0`, иначе `~01` превратится в `/` вместо `~1`.
 */
export function pointerToPath(pointer: string): FieldPath {
  if (pointer === '' || pointer === '/') return [];
  return pointer
    .replace(/^\//, '')
    .split('/')
    .map((segment) => {
      const unescaped = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      return /^\d+$/.test(unescaped) ? Number(unescaped) : unescaped;
    });
}

function samePath(left: FieldPath, right: FieldPath): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/**
 * Раскладка ошибок ответа по полям формы.
 *
 * `knownFields` — имена элементов формы. Совпадение считается по ПРЕФИКСУ:
 * сервер указывает на `/rules/0/severity`, а форма может иметь элемент `rules`
 * целиком (мультиселект), и подсветить нужно его.
 */
export function mapFieldErrors(
  error: unknown,
  knownFields: readonly FieldPath[],
): MappedFieldErrors {
  if (!isApiError(error)) return { fields: [], unmatched: [] };

  const byField = new Map<string, FieldErrorEntry>();
  const unmatched: string[] = [];

  for (const item of error.fieldErrors) {
    const path = pointerToPath(item.pointer ?? '');
    const target =
      knownFields.find((field) => samePath(field, path)) ??
      knownFields.find(
        (field) =>
          field.length < path.length &&
          field.every((part, index) => part === path[index]) &&
          field.length > 0,
      );

    if (target === undefined) {
      unmatched.push(item.message);
      continue;
    }

    const key = target.join('.');
    const existing = byField.get(key);
    if (existing === undefined) byField.set(key, { name: target, errors: [item.message] });
    else existing.errors.push(item.message);
  }

  return { fields: [...byField.values()], unmatched };
}

/**
 * Подсветка полей формы ответом сервера.
 *
 * Возвращает сообщения, которым не нашлось поля: вызывающий обязан показать их
 * сам, иначе отказ окажется без объяснения.
 *
 * Приведение типа здесь — единственная точка стыка двух систем именования полей.
 * antd выводит имя поля из типа значений формы и потому требует литеральный
 * путь, известный на компиляции; сервер называет поле указателем JSON Pointer,
 * то есть строкой времени выполнения. Совместить их без приведения нельзя, зато
 * оно ограничено одной строкой, а не рассыпано по каждой форме.
 */
export function applyFieldErrors<TValues>(
  form: FormInstance<TValues>,
  error: unknown,
  knownFields: readonly FieldPath[],
): string[] {
  const mapped = mapFieldErrors(error, knownFields);
  if (mapped.fields.length > 0) {
    form.setFields(mapped.fields as unknown as Parameters<FormInstance<TValues>['setFields']>[0]);
  }
  return mapped.unmatched;
}
