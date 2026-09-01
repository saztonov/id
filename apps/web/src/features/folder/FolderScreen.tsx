/**
 * Рабочее место ревизии комплекта: шесть вкладок §14.
 *
 * Активная вкладка живёт в адресе (`?tab=markup`), а не только в состоянии: без
 * этого ссылку на разметку конкретной ревизии нельзя ни отправить, ни открыть из
 * замечания, а обновление страницы возвращало бы пользователя на первую вкладку.
 *
 * Редактируемость определяется статусом ревизии, а не только правом: содержимое
 * поданной ревизии заперто триггерами БД (§3.9), и кнопка, которая гарантированно
 * получит отказ, вводит в заблуждение. Различение классов `source` и `derived`
 * (урок S2) здесь проявляется так: файлы правятся только в черновике, а разметка
 * и документы — пока ревизия не в терминальном состоянии.
 *
 * ## Поток событий живёт на уровне ревизии, а не вкладки
 *
 * Вкладки размонтируются при переключении (`destroyOnHidden`), и поток,
 * открытый внутри вкладки, обрывался бы при каждом переходе — с повторным
 * запросом пропущенного на ровном месте. Поэтому подписка держится здесь и
 * переживает переключение вкладок; состояние потока вкладки читают из контекста
 * (`stream.tsx`).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, Modal, Tabs, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { navigationKeys } from '../../api/keys.js';
import { deleteFolder, getFolder } from '../../api/navigation.js';
import { describeError } from '../../api/problem.js';
import { useSession } from '../../app/session.js';
import { ErrorState, LoadingState, ScreenHeading } from '../../shared/ui.js';
import { Link, useNavigate, useQueryParam } from '../../app/router.js';
import { periodLabel } from '../ids/pipelineState.js';
import { FilesTab } from '../files/FilesTab.js';
import { MarkupScreen } from '../markup/MarkupScreen.js';
import { ChecksTab } from '../checks/ChecksTab.js';
import { HistoryTab } from '../history/HistoryTab.js';
import { PipelineBar } from './PipelineBar.js';
import { FolderStreamProvider } from './stream.js';
import { StreamIndicator } from './StreamIndicator.js';

const TABS = ['files', 'markup', 'checks', 'history'] as const;
type TabKey = (typeof TABS)[number];

/**
 * Прежние вкладки «Документы» и «Реквизиты».
 *
 * На S24 они стали секциями «Проверки», на S27 удалены вместе с ней
 * (ADR-0016): портал больше не просит собирать документы и подтверждать
 * границы руками. Адреса при этом обязаны продолжать работать — по ним ходят
 * сохранённые ссылки и прежние переходы «finding → evidence», — но теперь ведут
 * на голую «Проверку»: секции, которую можно было бы раскрыть, больше нет.
 *
 * Переход сопровождается уведомлением. Молча открыть другой экран значило бы
 * сделать вид, что ссылка привела куда просили, и человек искал бы дерево
 * документов на вкладке, где его нет.
 */
const REMOVED_TABS: readonly string[] = ['documents', 'fields'];

/**
 * Подзаголовок: чем этот комплект является и куда он попадёт.
 *
 * Наименования здесь НЕТ намеренно, и это не потеря: его печатает заголовок
 * прямо над этой строкой. Пока заголовок показывал идентификатор поставки,
 * наименование стояло здесь и было единственным; после переноса заголовка на
 * комплект оно печаталось дважды подряд, и вторая копия не добавляла ни слова.
 * Осталось ровно то, чего заголовок не говорит: вид комплекта, месяц, объект и
 * состояние по реестру — четыре величины, по которым комплект и ищут.
 *
 * Отдельный запрос, а не поле рабочего процесса: рабочий процесс отвечает за
 * статус ревизии, и подмешивать в него карточку комплекта значило бы связать
 * два ответа, которые меняются по разным поводам. Ключ запроса тот же, что у
 * заголовка, — react-query объединяет их в один вызов, а не ходит дважды.
 */
function FolderLine({ folderId }: { folderId: string }): ReactNode {
  const folder = useQuery({
    queryKey: navigationKeys.folder(folderId),
    queryFn: () => getFolder(folderId),
  });

  if (folder.data === undefined || folder.data.kind !== 'available') return null;
  const data = folder.data.data;

  // Подчёркивание задано явно: ссылка внутри абзаца текста обязана отличаться
  // от него не только цветом (WCAG 1.4.1, правило axe `link-in-text-block`).
  const inline = { textDecoration: 'underline' } as const;

  return (
    <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
      Папка ИД · {periodLabel(data.period)} ·{' '}
      <Link to={`/ids/objects/${data.objectId}`} style={inline}>
        объект
      </Link>
    </Typography.Paragraph>
  );
}

/**
 * Удалить эту ревизию со всем производным.
 *
 * Нужна ровно там, где неудачную попытку хочется стереть и начать заново, — на
 * этапе тестирования это основной способ убрать за собой. Право `settings.manage`
 * то же, что у удаления комплекта: завести свою работу и стереть чужую вместе с
 * историей проверок — разные по весу действия.
 *
 * Препятствия (согласованная ревизия, переданный реестр, юридический запрет,
 * «единственная ревизия комплекта») сервер называет в 409 поимённо, и текст
 * показывается как есть. Отдельного предпросмотра с числами здесь нет намеренно:
 * у комплекта он оправдан — там за одной строкой прячется вся работа, — а здесь
 * человек уже стоит на экране этой самой ревизии и видит её содержимое вкладками.
 */
function DeleteFolderAction({ folderId }: { folderId: string }): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const folder = useQuery({
    queryKey: navigationKeys.folder(folderId),
    queryFn: () => getFolder(folderId),
  });

  const remove = useMutation({
    mutationFn: () => deleteFolder(folderId),
    onSuccess: async () => {
      message.success('Папка удалена вместе со всем содержимым');
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: navigationKeys.root });
      // Экран удалённой папки показывать нечего — уходим к объекту, откуда в
      // папку и заходят.
      const objectId = folder.data?.kind === 'available' ? folder.data.data.objectId : null;
      navigate(objectId === null ? '/ids' : `/ids/objects/${objectId}`);
    },
    onError: (error) => message.error(describeError(error)),
  });

  if (!can('settings.manage')) return null;

  return (
    <>
      <Button danger size="small" onClick={() => setOpen(true)} data-testid="delete-folder">
        Удалить ревизию
      </Button>
      <Modal
        open={open}
        title="Удалить ревизию?"
        okText="Удалить безвозвратно"
        cancelText="Отмена"
        okButtonProps={{ danger: true }}
        confirmLoading={remove.isPending}
        onCancel={() => setOpen(false)}
        onOk={() => remove.mutate()}
        destroyOnHidden
      >
        <Typography.Paragraph>
          Уйдут файлы, страницы, рабочий документ, разметка, распознанный текст, документы,
          реквизиты и замечания этой ревизии. Восстановления нет.
        </Typography.Paragraph>
      </Modal>
    </>
  );
}

export function FolderScreen({ folderId }: { folderId: string }): ReactNode {
  return (
    <FolderStreamProvider folderId={folderId}>
      <FolderWorkspace folderId={folderId} />
    </FolderStreamProvider>
  );
}

function FolderWorkspace({ folderId }: { folderId: string }): ReactNode {
  const navigate = useNavigate();
  const requested = useQueryParam('tab');
  const { message } = AntApp.useApp();
  const moved = requested !== null && REMOVED_TABS.includes(requested);
  const tab: TabKey = moved
    ? 'checks'
    : TABS.includes(requested as TabKey)
      ? (requested as TabKey)
      : 'files';

  // Старый адрес переписывается на новый, а не просто открывает «Проверку»:
  // иначе строка в браузере продолжала бы обещать вкладку, которой нет, и
  // копирование ссылки из адресной строки воспроизводило бы устаревший вид.
  useEffect(() => {
    if (!moved) return;
    navigate(`/ids/folders/${folderId}?tab=checks`, { replace: true });
    message.info(
      'Разделы «Документы» и «Реквизиты» удалены: портал больше не просит собирать документы вручную.',
    );
  }, [message, moved, navigate, folderId]);

  const folderQuery = useQuery({
    queryKey: navigationKeys.folder(folderId),
    queryFn: () => getFolder(folderId),
  });
  const folderTitle = folderQuery.data?.kind === 'available' ? folderQuery.data.data.title : null;

  if (folderQuery.isPending) return <LoadingState label="Загрузка папки…" />;
  if (folderQuery.isError) return <ErrorState error={folderQuery.error} title="Папка недоступна" />;

  // Статусов подачи больше нет (S44): править можно всё и всегда, а границу
  // «состав зафиксирован разметкой» держит сервер (`requireEditableFolder`).
  const sourceEditable = true;
  const derivedEditable = true;

  return (
    <>
      {/*
        Заголовок называет КОМПЛЕКТ, а не номер ревизии. Ряд «Ревизия № 1, 2, 3»
        выносил наружу внутреннее устройство хранения: человек работает с одним
        документом, а не с их историей, и повторное выделение блоков теперь
        перезаписывает разметку, а не заводит следующую по номеру.

        Наименование печатается здесь и только здесь: подзаголовок ниже говорит
        то, чего нет в заголовке, и названия не повторяет.
      */}
      <ScreenHeading
        title={folderTitle ?? 'Комплект работ'}
        extra={
          <>
            <StreamIndicator />
            <DeleteFolderAction folderId={folderId} />
          </>
        }
      />
      <FolderLine folderId={folderId} />

      {/*
        Две кнопки конвейера стоят НАД вкладками: они относятся к ревизии
        целиком, и «Проверить» с вкладки «Файлы» делает ровно то же, что с
        вкладки «Проверка». Внутри вкладки их пришлось бы искать.
      */}
      <PipelineBar folderId={folderId} editable={derivedEditable} />

      <Tabs
        activeKey={tab}
        onChange={(key) => navigate(`/ids/folders/${folderId}?tab=${key}`)}
        destroyOnHidden
        items={[
          {
            key: 'files',
            label: 'Файлы',
            children: <FilesTab folderId={folderId} editable={sourceEditable} />,
          },
          {
            key: 'markup',
            label: 'Разметка',
            children: <MarkupScreen folderId={folderId} />,
          },
          {
            key: 'checks',
            label: 'Проверка',
            children: <ChecksTab folderId={folderId} />,
          },
          {
            key: 'history',
            label: 'История',
            children: <HistoryTab folderId={folderId} />,
          },
        ]}
      />

      {!derivedEditable && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="Ревизия в терминальном состоянии"
          description="Разметка, документы и реквизиты этой ревизии больше не правятся."
        />
      )}
    </>
  );
}
