/**
 * Permission на маршруте — первый из трёх уровней изоляции (§4.1).
 *
 * Он отвечает на вопрос «имеет ли роль право на такое действие вообще», и
 * ничего не знает о конкретных строках: «можно ли ему именно эту поставку»
 * решает область видимости в репозитории. Оба уровня обязательны: permission
 * без области пустил бы подрядчика в чужие поставки, область без permission
 * позволила бы подрядчику согласовать собственную работу.
 *
 * Права проверяются по НАБОРУ ролей, а не по старшей роли. Это прямое
 * требование §4.1: администратор согласует ИД только при дополнительной роли
 * `manager`, поэтому `admin` отсутствует в согласующих правах — и это не
 * упущение таблицы.
 */
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { UserRole } from '@id/contracts';
import { forbidden } from '../lib/problem.js';
import { requireAuth, type PortalRole } from './require-auth.js';

/**
 * Каталог прав: право → роли, которым оно выдано.
 *
 * Матрицей, а не проверками внутри обработчиков: список из одного места видно
 * целиком, и вопрос «кто может вернуть ревизию» не требует чтения кода роутов.
 * Акцессора «роли по праву» при матрице нет: она сама открыта наружу и типизована
 * литералами, а функция из одной строки над ней только делала бы вид, что права
 * где-то ещё перечисляются.
 */
export const PERMISSIONS = {
  /** Чтение комплектов и ревизий в пределах своей области видимости. */
  'submission.read': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  /**
   * Заведение комплекта и загрузка файлов — все пять ролей.
   *
   * До S21 право было выдано только подрядчику и генподрядчику: «подаёт тот,
   * кто выполнил». Заказчик снял эту посылку — загрузить исправленную версию
   * вправе и инженер, и руководитель, и администратор, потому что бумагу
   * приносят на стол, а не только заливают в портал, и ждать учётной записи
   * субподрядчика ради одного скана никто не станет.
   *
   * Кого именно проверяющий вправе указать исполнителем, решает не право, а
   * закрепление подрядчика за объектом (`works_contractor_fk`), а сам факт
   * подачи за другого фиксируется в аудите признаком `onBehalfOf`
   * (`requireManagedByActor`). Изоляция «подрядчик не правит чужой комплект»
   * этим не ослаблена: она держится областью видимости, а не этой строкой.
   */
  'submission.upload': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  'submission.submit': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],

  'markup.read': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],
  /**
   * Правка разметки, её заморозка и отправка на распознавание.
   *
   * Администратор добавлен к трём исполняющим ролям в S24. До этого он имел
   * `markup.read` и не имел `markup.edit`, и это выглядело на экране не как
   * ограничение прав, а как сломанный портал: панель инструментов разметки
   * рисуется всегда, а `editable = can('markup.edit') && !frozen` гасил в ней
   * ВСЁ разом — выбор инструмента, тип блока, повтор детекции, замену
   * страницы, заморозку. Отличить «нет права» от «кнопки не работают» человеку
   * было нечем.
   *
   * Расширение узкое и осознанное: `admin` уже вправе завести комплект,
   * загрузить в него файлы и запустить конвейер (`submission.upload`,
   * `pipeline.run`), то есть создать разметку он мог и раньше — не мог только
   * поправить её результат. Решения о самом документе это не касается:
   * `document.edit`, `checks.run` и `revision.approve` у администратора
   * по-прежнему нет, и приёмку он не подписывает.
   */
  'markup.edit': ['contractor', 'general_contractor', 'engineer', 'admin'],
  'markup.freeze': ['contractor', 'general_contractor', 'engineer', 'admin'],
  'recognition.start': ['contractor', 'general_contractor', 'engineer', 'admin'],

  /**
   * Границы документов, тип, реквизиты: правит проверяющий, не подрядчик.
   *
   * Расширять это право на подрядчика ради кнопки «Проверить» нельзя, и это
   * проверено, а не предположено: тем же правом закрыт
   * `POST /documents/{id}/confirm` — подтверждение границ, отсутствие которого
   * стоит в `approveBlockers`. Подрядчик, получивший `document.edit`, снимал бы
   * себе условие согласования. Запуск стадий конвейера вынесен в `pipeline.run`.
   */
  'document.edit': ['engineer', 'manager'],
  'checks.run': ['engineer', 'manager'],

  /**
   * Запуск стадий конвейера по комплекту в своей области видимости.
   *
   * Отдельное право, а не расширение `document.edit`/`checks.run`, потому что
   * это другое действие: «поставить задачу в очередь» против «принять решение о
   * документе». Заказчик назвал запускающими проверку и инженера, и подрядчика
   * («важна информация о том, есть ли ошибки в документе»), а загружать вправе
   * все пять ролей — значит и прогнать загруженное тоже.
   *
   * Право покрывает обе кнопки S21 (`POST /revisions/{id}/markup` и
   * `POST /revisions/{id}/check`) целиком, включая заморозку разметки внутри
   * второй: единое действие авторизуется один раз, иначе «Проверить» была бы
   * склейкой четырёх проверок прав, у которой на каждом шаге свой ответ.
   * Гранулярные маршруты (`/layout`, `/freeze`, `/recognize`, `/segment`,
   * `/checks`) свои прежние права сохраняют — это ручной путь инженера.
   */
  'pipeline.run': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],

  /**
   * Ведение реестра: собрать состав, загрузить скан описи, передать папку.
   *
   * Отдельно от `submission.*`, потому что это другое действие и другой актор:
   * подрядчик подаёт свой комплект, а реестр собирает и подписывает ПТО
   * генподрядчика. Администратор входит сюда как обычно — ему нужно уметь
   * разобрать застрявшую папку.
   */
  'registry.manage': ['general_contractor', 'admin'],
  /**
   * Приёмка переданной папки — подпись «Принял» в подвале реестра.
   *
   * Это сторона заказчика, а не генподрядчика: тот, кто передал, не принимает
   * сам у себя. `admin` здесь отсутствует по той же причине, что и в
   * `revision.approve` (§4.1).
   */
  'registry.accept': ['engineer', 'manager'],

  // Бизнес-согласование. `admin` здесь намеренно отсутствует (§4.1).
  'revision.approve': ['engineer', 'manager'],
  'revision.return': ['engineer', 'manager'],
  /** Обоснованный отказ от результата проверки — только руководитель. */
  'revision.override': ['manager'],

  'archive.download': ['contractor', 'general_contractor', 'engineer', 'manager', 'admin'],

  'users.manage': ['admin'],
  'settings.manage': ['admin'],
  'rules.publish': ['admin'],
  'doc_types.manage': ['admin'],
  'diagnostics.read': ['admin'],
  'audit.read': ['admin'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

/**
 * Аргумент типа `PortalRole`, а не `UserRole`: подставить сюда строку из
 * `realm_access.roles` не получится, потому что метку ставит только
 * `buildScope()`, читающий `user_roles` (§4.1).
 *
 * Обёртки «проверить право внутри обработчика» здесь нет намеренно. Она была, и
 * ни один обработчик её не вызывал: право на маршрут в портале всегда известно до
 * разбора тела. Когда такой случай появится, обработчик спросит `hasPermission` и
 * бросит `forbidden` сам — двух строк на это достаточно, а экспорт, который никто
 * не вызывает, выглядит работающей защитой и скрывает, что случая ещё нет.
 */
export function hasPermission(roles: readonly PortalRole[], permission: Permission): boolean {
  // Аннотация обязательна: без неё `PERMISSIONS[permission]` — объединение
  // литеральных кортежей, и параметр `includes` сводится к `never`.
  const allowed: readonly UserRole[] = PERMISSIONS[permission];
  return roles.some((role) => allowed.includes(role));
}

export function requirePermission(permission: Permission): preHandlerAsyncHookHandler {
  return async function checkPermission(request: FastifyRequest) {
    // Аутентификация раньше авторизации: иначе анонимный запрос получил бы 403
    // вместо 401 и клиент не понял бы, что нужно войти.
    await requireAuth(request);
    if (!hasPermission(request.authContext?.roles ?? [], permission)) {
      throw permissionDenied(permission);
    }
  };
}

/**
 * Достаточно ЛЮБОГО из перечисленных прав.
 *
 * Нужно там, где одно и то же действие принадлежит двум разным ролям по разным
 * причинам: настройку объекта ведёт генподрядчик, потому что это его стройка, и
 * администратор, потому что он разбирает застрявшее. Складывать роли в одно
 * право было бы неверно — право отвечает на вопрос «что за действие», а не «кто
 * его делает», и `registry.manage` у администратора означал бы, что он ещё и
 * передаёт папки.
 */
export function requireAnyPermission(
  permissions: readonly Permission[],
): preHandlerAsyncHookHandler {
  return async function checkAnyPermission(request: FastifyRequest) {
    await requireAuth(request);
    const roles = request.authContext?.roles ?? [];
    if (!permissions.some((permission) => hasPermission(roles, permission))) {
      throw permissionDenied(permissions[0] ?? 'settings.manage');
    }
  };
}

function permissionDenied(permission: Permission) {
  return forbidden('Недостаточно прав для этого действия.', {
    // Право в detail не раскрывается: перечень прав портала — часть его
    // внутреннего устройства. В журнал оно попадает.
    logDetail: `отказано по праву ${permission}`,
  });
}
