/**
 * Точка входа SPA. Полноценный интерфейс собирается на этапе S11;
 * на S0 здесь минимальный каркас, обеспечивающий сборку и typecheck.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const container = document.getElementById('root');
if (!container) throw new Error('Не найден корневой элемент #root');

createRoot(container).render(
  <StrictMode>
    <div>Портал исполнительной документации</div>
  </StrictMode>,
);
