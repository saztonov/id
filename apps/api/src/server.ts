/**
 * Точка входа процесса API.
 *
 * Отдельно от `app.ts`: сборка приложения обязана быть вызываемой из тестов без
 * открытия сокета и без обработчиков сигналов процесса.
 */
import { buildApp } from './app.js';
import { EnvError, loadEnv, type Env } from './config/env.js';
import { errorDigest, installProcessErrorHandlers } from './observability/errors.js';

/**
 * Потолок ожидания завершения запросов.
 *
 * Docker присылает SIGKILL через 10 секунд после SIGTERM по умолчанию, поэтому
 * ждать дольше бессмысленно: процесс всё равно убьют, но уже без записи в
 * журнал о том, что именно не завершилось.
 */
const SHUTDOWN_TIMEOUT_MS = 8000;

function readEnv(): Env {
  try {
    return loadEnv();
  } catch (error) {
    if (error instanceof EnvError) {
      // Конфигурация проверяется до создания логгера, поэтому вывод идёт в
      // stderr напрямую: иначе причина отказа старта пропала бы.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  const app = await buildApp({ env });

  let shuttingDown = false;
  const shutdown = (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ event: 'shutdown', signal }, 'получен сигнал завершения, закрываем приложение');

    // Таймер не даёт зависшему запросу или соединению задержать выход. unref()
    // нужен, чтобы сам таймер не держал event loop, если закрытие пройдёт быстро.
    const forceExit = setTimeout(() => {
      app.log.error('завершение не уложилось в отведённое время, выходим принудительно');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // app.close() выполняет хук onClose, который закрывает пул PostgreSQL.
    app.close().then(
      () => {
        clearTimeout(forceExit);
        process.exit(exitCode);
      },
      (error: unknown) => {
        // Выжимка, а не объект ошибки: в ошибке драйвера лежит текст SQL и
        // значения параметров последнего запроса (§11).
        app.log.error(
          { event: 'shutdown_failed', ...errorDigest(error) },
          'ошибка при закрытии приложения',
        );
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  /**
   * Падения вне обработчика запроса.
   *
   * Регистрацию в `error_events` и структурированную строку журнала делает слой
   * наблюдаемости: без него от такого падения остаётся только трассировка в
   * stdout, по которой нет ни дедупликации, ни счётчика повторов (§11).
   * Собственный выход слоя отключён — процесс гасится через graceful shutdown,
   * иначе `process.exit()` оборвал бы запросы в работе и закрытие пула.
   *
   * Процесс с необработанным исключением находится в неизвестном состоянии:
   * продолжать обслуживать запросы в нём опаснее, чем перезапуститься.
   */
  installProcessErrorHandlers({
    reporter: app.errorReporter,
    logger: app.log,
    exitOnUncaught: false,
  });

  process.on('uncaughtException', () => {
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', () => {
    shutdown('unhandledRejection', 1);
  });

  // 0.0.0.0, а не localhost: процесс живёт в контейнере, и запросы приходят с
  // адреса моста, а не с петлевого интерфейса.
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error('Не удалось запустить API:', error instanceof Error ? error.message : error);
  process.exit(1);
});
