/**
 * Администрирование (§14): пользователи и области видимости, кандидаты в виды
 * ИД, задачи, диагностика, аудит, настройки, правила и промты.
 *
 * ## Правила и промты живут на разных вкладках, хотя обе про «методику»
 *
 * У них разный жизненный цикл, и слить их значило бы обещать несуществующее.
 * Набор правил публикуется снимком и откатывается переключением действующей
 * версии; промт проходит `draft → test → published` и откатывается возвратом
 * прежней версии в эксплуатацию. Общая вкладка заставила бы один набор кнопок
 * означать два разных механизма.
 *
 * ## Кандидаты в виды ИД — цикл роста каталога
 *
 * Это не служебная таблица, а основной механизм, которым портал покрывает
 * разделы, отсутствовавшие в корпусе (§0.5, п. 3). Поэтому у кандидата есть обе
 * кнопки плана: «сопоставить с существующим» и «завести тип».
 *
 * ## Диагностика — первый потребитель права `diagnostics.read`
 *
 * До S11 это право было объявлено в матрице и не имело ни одного экрана: журнал
 * исполнения фиксировал его как долг четыре этапа подряд. Здесь оно получает
 * потребителя — консоль задач, глубина очереди и попытки с последними ошибками.
 */
import { type ReactNode } from 'react';
import { Tabs } from 'antd';
import { ScreenHeading } from '../../shared/ui.js';
import { useNavigate, useQueryParam } from '../../app/router.js';
import { UsersPanel } from './UsersPanel.js';
import { CandidatesPanel } from './CandidatesPanel.js';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';
import { AuditPanel } from './AuditPanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import { RulesPanel } from './RulesPanel.js';
import { PromptsPanel } from './PromptsPanel.js';

const TABS = [
  'users',
  'candidates',
  'diagnostics',
  'audit',
  'settings',
  'rules',
  'prompts',
] as const;
type TabKey = (typeof TABS)[number];

export function AdminScreen(): ReactNode {
  const navigate = useNavigate();
  const requested = useQueryParam('tab');
  const tab: TabKey = TABS.includes(requested as TabKey) ? (requested as TabKey) : 'users';

  return (
    <>
      <ScreenHeading title="Администрирование" />
      <Tabs
        activeKey={tab}
        onChange={(key) => navigate(`/admin?tab=${key}`)}
        destroyOnHidden
        items={[
          { key: 'users', label: 'Пользователи и области', children: <UsersPanel /> },
          { key: 'candidates', label: 'Кандидаты в виды ИД', children: <CandidatesPanel /> },
          { key: 'diagnostics', label: 'Диагностика и задачи', children: <DiagnosticsPanel /> },
          { key: 'audit', label: 'Аудит', children: <AuditPanel /> },
          { key: 'settings', label: 'Настройки и интеграции', children: <SettingsPanel /> },
          { key: 'rules', label: 'Правила и ruleset', children: <RulesPanel /> },
          { key: 'prompts', label: 'AI и промты', children: <PromptsPanel /> },
        ]}
      />
    </>
  );
}
