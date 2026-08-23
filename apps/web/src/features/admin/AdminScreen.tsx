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
 * ## Вкладки горизонтальные, и это потребовало сократить их до семи
 *
 * История такая. Пока меню было горизонтальной полосой, девять вкладок в ширину
 * помещались. Боковое меню (S18) забрало 240 пикселей, у `Tabs` antd появилась
 * кнопка свёртки — а она нарушает `aria-required-children`: внутри `tablist`
 * оказывается элемент, вкладкой не являющийся. Найдено прогоном axe, а не
 * рассуждением, и тогда вкладки поставили столбцом (`tabPosition="left"`).
 *
 * Вертикальный столбец расходился со справочниками, где ряд горизонтальный, и
 * заказчик просил их выровнять. Просто снять `tabPosition` нельзя — вернулся бы
 * тот же дефект axe. Поэтому вкладок стало СЕМЬ, ровно столько же, сколько в
 * справочниках, где ряд помещается и axe зелёный. Сокращение — не переименование:
 * две пары экранов действительно съехались в одну вкладку каждая.
 *
 * ## Что с чем слито и почему именно так
 *
 * «Заявки на доступ» ушли внутрь «Пользователей»: заявка — это будущая учётная
 * запись, и человек, который её рассматривает, тем же заходом правит роли уже
 * заведённых. Разделять их вкладкой значило бы разводить два шага одной работы.
 *
 * «Журнал и качество» ушёл внутрь «Диагностики». Горизонт у них разный —
 * диагностика отвечает «что происходит прямо сейчас», журнал «что ломалось и чем
 * это чинили», — и внутри вкладки они остаются РАЗНЫМИ разделами, переключаемыми
 * явно. Приём тот же, которым внутри самого журнала разведены проблемы, аномалии
 * и качество конвейера: `Segmented`, а не вложенные `Tabs`, — вложенный `tablist`
 * дал бы ту же кнопку свёртки этажом ниже.
 *
 * ## Старые адреса вкладок продолжают работать
 *
 * `/admin?tab=journal` и `/admin?tab=registration` разосланы ссылками и стоят в
 * прогонах. Молча отдавать по ним «Пользователей» — то же самое, что сломать
 * ссылку, только незаметно. `TAB_ALIASES` переводит старый ключ в пару «вкладка +
 * раздел», и человек попадает ровно туда, куда шёл.
 */
import { useState, type ReactNode } from 'react';
import { Segmented, Space, Tabs } from 'antd';
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
  'candidates',
  'diagnostics',
  'audit',
  'settings',
  'rules',
  'prompts',
] as const;
type TabKey = (typeof TABS)[number];

type UsersSection = 'accounts' | 'registration';
type DiagnosticsSection = 'now' | 'journal';

/**
 * Ключи вкладок, существовавших до слияния.
 *
 * Значение — вкладка, в которую раздел переехал, и раздел внутри неё. Второе
 * обязательно: привести на «Диагностику» того, кто шёл в журнал ошибок, значит
 * ответить не на тот вопрос.
 */
const TAB_ALIASES: Record<string, { readonly tab: TabKey; readonly section: string }> = {
  registration: { tab: 'users', section: 'registration' },
  journal: { tab: 'diagnostics', section: 'journal' },
};

export function AdminScreen(): ReactNode {
  const navigate = useNavigate();
  const { me } = useSession();
  const requested = useQueryParam('tab') ?? '';
  const alias = TAB_ALIASES[requested];
  const tab: TabKey =
    alias?.tab ?? (TABS.includes(requested as TabKey) ? (requested as TabKey) : 'users');

  return (
    <>
      <ScreenHeading title="Администрирование" />
      <Tabs
        activeKey={tab}
        onChange={(key) => navigate(`/admin?tab=${key}`)}
        destroyOnHidden
        items={[
          {
            key: 'users',
            label: 'Пользователи',
            children: (
              <UsersTab
                localAuth={me.authMode === 'local'}
                initialSection={alias?.section === 'registration' ? 'registration' : 'accounts'}
              />
            ),
          },
          { key: 'candidates', label: 'Кандидаты', children: <CandidatesPanel /> },
          {
            key: 'diagnostics',
            label: 'Диагностика',
            children: (
              <DiagnosticsTab initialSection={alias?.section === 'journal' ? 'journal' : 'now'} />
            ),
          },
          { key: 'audit', label: 'Аудит', children: <AuditPanel /> },
          { key: 'settings', label: 'Настройки', children: <SettingsPanel /> },
          { key: 'rules', label: 'Правила', children: <RulesPanel /> },
          { key: 'prompts', label: 'Промты', children: <PromptsPanel /> },
        ]}
      />
    </>
  );
}

/**
 * Учётные записи и заявки на доступ.
 *
 * Переключателя нет вовсе, когда портал паролями не распоряжается: в
 * федеративном режиме заявок на регистрацию не бывает, и `Segmented` из одного
 * пункта обещал бы выбор, которого нет.
 */
function UsersTab({
  localAuth,
  initialSection,
}: {
  localAuth: boolean;
  initialSection: UsersSection;
}): ReactNode {
  const [section, setSection] = useState<UsersSection>(localAuth ? initialSection : 'accounts');

  if (!localAuth) return <UsersPanel />;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Segmented<UsersSection>
        value={section}
        onChange={setSection}
        options={[
          { label: 'Учётные записи', value: 'accounts' },
          { label: 'Заявки на доступ', value: 'registration' },
        ]}
        aria-label="Раздел управления пользователями"
      />
      {section === 'accounts' && <UsersPanel />}
      {section === 'registration' && <RegistrationRequestsPanel />}
    </Space>
  );
}

/** Что происходит сейчас — и что ломалось раньше. */
function DiagnosticsTab({ initialSection }: { initialSection: DiagnosticsSection }): ReactNode {
  const [section, setSection] = useState<DiagnosticsSection>(initialSection);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Segmented<DiagnosticsSection>
        value={section}
        onChange={setSection}
        options={[
          { label: 'Задачи и очередь', value: 'now' },
          { label: 'Журнал и качество', value: 'journal' },
        ]}
        aria-label="Раздел диагностики"
      />
      {section === 'now' && <DiagnosticsPanel />}
      {section === 'journal' && <ErrorJournalPanel />}
    </Space>
  );
}
