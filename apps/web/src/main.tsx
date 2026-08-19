/**
 * Точка входа SPA.
 *
 * Здесь только монтирование: провайдеры, вход и маршруты собирает `App`,
 * потому что то же дерево поднимает Playwright-прогон, и разойтись эти два
 * запуска не должны.
 */
import { createRoot } from 'react-dom/client';
import { App } from './app/App.js';

const container = document.getElementById('root');
if (container === null) throw new Error('Не найден корневой элемент #root');

createRoot(container).render(<App />);
