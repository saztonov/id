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
import { requireAuth, type AuthContext, type PortalRole } from './require-auth.js';

/**
 * Каталог прав: право → роли, которым оно выдано.
 *
 * Матрицей, а не проверками внутри обработчиков: список из одного места видно
 * целиком, и вопрос «кто может вернуть ревизию» не требует чтения кода роутов.
 */
export const PERMISSIONS = {
  /** Чтение поставок и ревизий в пределах своей области видимости. */
  'submission.read': ['contractor', 'engineer', 'manager', 'admin'],
  'submission.upload': ['contractor'],
  'submission.submit': ['contractor'],

  'markup.read': ['contractor', 'engineer', 'manager', 'admin'],
  'markup.edit': ['contractor', 'engineer'],
  'markup.freeze': ['contractor', 'engineer'],
  'recognition.start': ['contractor', 'engineer'],

  /** Границы документов, тип, реквизиты: правит проверяющий, не подрядчик. */
  'document.edit': ['engineer', 'manager'],
  'checks.run': ['engineer', 'manager'],

  // Бизнес-согласование. `admin` здесь намеренно отсутствует (§4.1).
  'revision.approve': ['engineer', 'manager'],
  'revision.return': ['engineer', 'manager'],
  /** Обоснованный отказ от результата проверки — только руководитель. */
  'revision.override': ['manager'],

  'archive.download': ['contractor', 'engineer', 'manager', 'admin'],

  'users.manage': ['admin'],
  'settings.manage': ['admin'],
  'rules.publish': ['admin'],
  'doc_types.manage': ['admin'],
  'diagnostics.read': ['admin'],
  'audit.read': ['admin'],
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function rolesWithPermission(permission: Permission): readonly UserRole[] {
  return PERMISSIONS[permission];
}

/**
 * Аргумент типа `PortalRole`, а не `UserRole`: подставить сюда строку из
 * `realm_access.roles` не получится, потому что метку ставит только
 * `buildScope()`, читающий `user_roles` (§4.1).
 */
export function hasPermission(roles: readonly PortalRole[], permission: Permission): boolean {
  // Аннотация обязательна: без неё `PERMISSIONS[permission]` — объединение
  // литеральных кортежей, и параметр `includes` сводится к `never`.
  const allowed: readonly UserRole[] = PERMISSIONS[permission];
  return roles.some((role) => allowed.includes(role));
}

/** Проверка внутри обработчика — там, где право зависит от разобранного тела. */
export function assertPermission(auth: AuthContext, permission: Permission): void {
  if (!hasPermission(auth.roles, permission)) throw permissionDenied(permission);
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

function permissionDenied(permission: Permission) {
  return forbidden('Недостаточно прав для этого действия.', {
    // Право в detail не раскрывается: перечень прав портала — часть его
    // внутреннего устройства. В журнал оно попадает.
    logDetail: `отказано по праву ${permission}`,
  });
}
