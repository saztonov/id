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
 *
 * ## Журнал и качество — одна вкладка с двумя разделами
 *
 * Разделов два, а вкладка одна, и это не экономия места: у `Tabs` antd при
 * переполнении появляется кнопка свёртки, а она нарушает `aria-required-children`
 * — внутри `tablist` оказывается элемент, вкладкой не являющийся. Найдено
 * прогоном axe, а не рассуждением. Разделы при этом честно разные и переключаются
 * явно, а не прячутся один в другом.
 *
 * ## Вкладки вертикальные, и это следствие того же дефекта
 *
 * Пока меню было горизонтальной полосой, девять вкладок в ширину помещались, и
 * кнопка свёртки не появлялась. Боковое меню (S18) забрало 240 пикселей, и
 * дефект вернулся — то есть «уместить в ширину» никогда и не было решением, оно
 * лишь откладывало отказ до первого узкого экрана. `tabPosition="left"`
 * убирает переполнение по построению: девять пунктов стоят столбцом и
 * сворачивать нечего. Заодно это честнее по смыслу — вкладок здесь столько,
 * что горизонтальный ряд из них всё равно читался списком.
 *
 * ## Журнал — отдельная вкладка, а не карточка в диагностике
 *
 * У них разный горизонт и разный вопрос. Диагностика отвечает «что происходит
 * прямо сейчас»: очередь, выполняющиеся задачи, последние попытки. Журнал
 * отвечает «что ломалось и чем это чинили» — с историей, статусами и разбором,
 * который живёт годами. Общая вкладка заставила бы один экран обслуживать
 * дежурство и разбор накопленного, а это разные режимы работы.
 */
import { type ReactNode } from 'react';
import { Tabs } from 'antd';
import { ScreenHeading } from '../../shared/ui.js';
import { useNavigate, useQueryParam } from '../../app/router.js';
import { useSession } from '../../app/session.js';
import { RegistrationRequestsPanel } from './RegistrationRequestsPanel.js';
import { UsersPanel } from './UsersPanel.js';
import { CandidatesPanel } from './CandidatesPanel.js';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';
import { ErrorJournalPanel } from './ErrorJournalPanel.js';
import { AuditPanel } from './AuditPanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import { RulesPanel } from './RulesPanel.js';
import { PromptsPanel } from './PromptsPanel.js';

const TABS = [
  'users',
  'registration',
  'candidates',
  'diagnostics',
  'journal',
  'audit',
  'settings',
  'rules',
  'prompts',
] as const;
type TabKey = (typeof TABS)[number];

export function AdminScreen(): ReactNode {
  const navigate = useNavigate();
  const { me } = useSession();
  const requested = useQueryParam('tab');
  const tab: TabKey = TABS.includes(requested as TabKey) ? (requested as TabKey) : 'users';

  return (
    <>
      <ScreenHeading title="Администрирование" />
      <Tabs
        tabPosition="left"
        activeKey={tab}
        onChange={(key) => navigate(`/admin?tab=${key}`)}
        destroyOnHidden
        items={[
          { key: 'users', label: 'Пользователи и области', children: <UsersPanel /> },
          // Вкладка существует только там, где портал распоряжается паролями:
          // в федеративном режиме заявок на регистрацию не бывает.
          ...(me.authMode === 'local'
            ? [
                {
                  key: 'registration',
                  label: 'Заявки на доступ',
                  children: <RegistrationRequestsPanel />,
                },
              ]
            : []),
          { key: 'candidates', label: 'Кандидаты в виды ИД', children: <CandidatesPanel /> },
          { key: 'diagnostics', label: 'Диагностика и задачи', children: <DiagnosticsPanel /> },
          { key: 'journal', label: 'Журнал и качество', children: <ErrorJournalPanel /> },
          { key: 'audit', label: 'Аудит', children: <AuditPanel /> },
          { key: 'settings', label: 'Настройки и интеграции', children: <SettingsPanel /> },
          { key: 'rules', label: 'Правила и ruleset', children: <RulesPanel /> },
          { key: 'prompts', label: 'AI и промты', children: <PromptsPanel /> },
        ]}
      />
    </>
  );
}
