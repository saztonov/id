/**
 * Плашка «доступна новая версия приложения».
 *
 * ## Зачем она нужна
 *
 * Портал — SPA: вкладка, открытая до выкатки, держит прежний бандл сколько
 * угодно долго. Человек продолжает работать в старом интерфейсе и шлёт запросы
 * старым кодом в новый API — а узнать об этом ему неоткуда, притом что лечится
 * всё перезагрузкой страницы. Плашка и есть единственное место, где портал об
 * этом сообщает.
 *
 * ## Как определяется расхождение
 *
 * `vite build` кладёт в сборку `version.json` с меткой выкатки и ту же метку
 * вшивает в бандл (`__BUILD_ID__`, см. `buildVersion.ts` и `vite.config.ts`).
 * Файл раздаётся с `Cache-Control: no-store` (`nginx.conf`), поэтому вкладка
 * всегда читает опубликованное значение, а не своё собственное из кэша.
 *
 * Запрос идёт обычным `fetch`, мимо `api/queue.ts`: это статика с `id-web`, а
 * не API, у неё нет ни CSRF, ни серверного лимита запросов, и тратить на неё
 * общий бюджет очереди незачем. Любая ошибка (offline, 404, не-JSON) молча
 * игнорируется — сверка версий не тот повод, чтобы тревожить человека.
 *
 * ## Почему опрос, а не поток
 *
 * Событие о выкатке некому послать: SSE-поток портала живёт на `id-api` и знает
 * о ревизиях, а не о том, какой бандл лежит на раздаче статики. Проверка
 * привязана к вниманию человека — монтирование, возврат фокуса на вкладку — и
 * только фоном идёт раз в десять минут: чаще незачем, выкатки редки.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from 'antd';
import { BUILD_ID, isOutdatedBuild } from './buildVersion.js';

/** Фоновый интервал проверки. Основной сигнал — возврат к вкладке. */
const POLL_MS = 10 * 60_000;

function useOutdatedBuild(): boolean {
  const [outdated, setOutdated] = useState(false);

  useEffect(() => {
    // В разработке `version.json` не эмитится вовсе, а сборка без
    // `APP_RELEASE` не названа: сравнивать не с чем, и опрос не нужен.
    if (import.meta.env.DEV || BUILD_ID === undefined) return;

    let stopped = false;

    async function check(): Promise<void> {
      if (stopped) return;
      try {
        // Строка запроса — не суеверие: `no-store` управляет кэшем браузера, а
        // между вкладкой и `id-web` стоит ingress со своими правилами.
        const response = await fetch(`/version.json?ts=${String(Date.now())}`, {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const published: unknown = await response.json();
        if (stopped || !isOutdatedBuild(BUILD_ID, published)) return;

        // Дальше опрашивать нечего: ответ уже не изменится, а плашка показана.
        stopped = true;
        clearInterval(timer);
        setOutdated(true);
      } catch {
        // Сеть, 404 или ответ не той формы — вкладке нечего сообщать.
      }
    }

    function onVisible(): void {
      if (document.visibilityState === 'visible') void check();
    }

    // Объявление после `check`: тот гасит таймер, найдя расхождение, а вызовы
    // начинаются строкой ниже — то есть уже после присваивания.
    const timer = setInterval(() => void check(), POLL_MS);
    void check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  return outdated;
}

/**
 * Плашка поверх всего содержимого.
 *
 * `zIndex` выше диалогов antd (1000): предложение обновиться приходит и тогда,
 * когда открыто модальное окно, и прятаться за ним не должно. Низ по центру —
 * чтобы не перекрывать шапку и панель действий, за которыми человек тянется.
 *
 * «Позже» скрывает плашку до перезагрузки страницы и ничего не запоминает:
 * человек, отложивший обновление посреди разметки, не должен получать
 * напоминание каждые десять минут. Перезагрузка всё равно приведёт его на новый
 * бандл, и вопрос снимется сам.
 */
export function AppUpdateBanner(): ReactNode {
  const outdated = useOutdatedBuild();
  const [dismissed, setDismissed] = useState(false);

  if (!outdated || dismissed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="app-update-banner"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 16,
        transform: 'translateX(-50%)',
        zIndex: 2000,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 16,
        maxWidth: 'calc(100vw - 32px)',
        padding: '12px 16px',
        borderRadius: 8,
        background: '#1f1f1f',
        color: '#fff',
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.28)',
      }}
    >
      <span>Доступна новая версия приложения</span>
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
        <Button
          type="primary"
          data-testid="app-update-reload"
          onClick={() => {
            window.location.reload();
          }}
        >
          Обновить
        </Button>
        <Button
          data-testid="app-update-dismiss"
          onClick={() => {
            setDismissed(true);
          }}
        >
          Позже
        </Button>
      </div>
    </div>
  );
}
