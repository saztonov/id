/**
 * Экран разметки — ядро S11 (§7).
 *
 * Слева лента миниатюр с бейджами флагов, в центре канва `react-konva` с
 * рамками, справа список блоков с чекбоксами и фильтром, снизу «Отправить на
 * распознавание». Все действия §7.2 доступны, и каждое из них ходит в настоящее
 * API: экран, который не вызывает API, — это тот же отказ «написано, но не
 * подключено», которым закончились S3, S5 и S6.
 *
 * ## Изображение страницы
 *
 * Страница берётся не из рабочего PDF, а из ИСХОДНОГО файла по карте
 * `processing_bundle_pages`: `workingPageIndex → { sourceFileId, filePageIndex }`.
 * Причина не в удобстве — маршрута выдачи байтов рабочего документа в API нет
 * вовсе, а исходный файл отдаётся `GET /files/{id}/content` с поддержкой
 * `Range`. Фрейм при этом тот же: рабочий PDF собирается склейкой через `qpdf`,
 * то есть `/Rotate` и содержимое страницы переносятся без изменений. Совпадение
 * фреймов не предполагается, а проверяется: `framesAgree()` сравнивает
 * пропорции страницы из карты и вьюпорта pdf.js, и расхождение показывается
 * пользователю, а не игнорируется.
 *
 * ## Распознавание
 *
 * Две кнопки §6 разнесены: «Разметить файл» живёт на вкладке «Файлы» (там же,
 * где собирается рабочий документ), а здесь — отправка на распознавание.
 * Идентификатор разметки передаётся явно (§14): «возьми текущую» распознало бы
 * не то, что видел пользователь. Заморозки перед отправкой больше нет (0048):
 * блоки правятся всегда, и отправить их можно повторно.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Select,
  Space,
  Spin,
  Splitter,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttentionFlag, BlockType } from '@id/contracts';

import { bundles, catalog, documents, layout, recognition } from '../../api/endpoints.js';
import { catalogKeys, layoutKeys, recognitionKeys, revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { LayoutBlock, PageClassification } from '../../api/types.js';
import { files as filesApi } from '../../api/endpoints.js';
import { useSession } from '../../app/session.js';
import { RecognizedText } from './RecognizedText.js';
import { useQueryParam } from '../../app/router.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { LAYOUT_STATE_LABELS } from '../../shared/labels.js';
import { PageCanvas } from './PageCanvas.js';
import { PageTypePanel } from './PageTypePanel.js';
import { ThumbnailStrip, type PageTypeBadge } from './ThumbnailStrip.js';
import { VersionConflictModal } from './VersionConflictModal.js';
import {
  coverageOf,
  describeBlock,
  readingRanks,
  sortedForReading,
  BLOCK_STYLES,
} from './blocks.js';
import { framesAgree, fitInto, type RenderedSize } from './geometry.js';
import { closeDocuments } from './pdf/pdfjs.js';
import { renderWidthFor } from './pdf/render-width.js';
import { clearPageCache, prefetchPage, usePdfPage } from './pdf/usePdfPage.js';
import { useLayoutEditing } from './useLayoutEditing.js';
import { CanvasViewBar } from './CanvasViewBar.js';
import { usePageOrientation } from './usePageOrientation.js';
import { applyRotation, normalizeRotation, rotateBy } from './rotation.js';
import {
  COLUMN_MIN,
  mergeSizesWithoutText,
  pixelsToPercent,
  sizesWithoutText,
} from './workspaceLayout.js';
import { anchoredScroll, effectiveZoom, stepZoom, WHEEL_ZOOM_FACTOR, clampZoom } from './zoom.js';
import { useShallow } from 'zustand/react/shallow';

import { useMarkupStore } from './store.js';

export interface MarkupScreenProps {
  readonly revisionId: string;
}

/**
 * Высота рабочей области — ОДНА величина на весь экран.
 *
 * Прежде `72vh` стояло в трёх местах (две боковые колонки и контейнер
 * прокрутки канвы), а текст держал собственные `32vh`. Четыре копии одного
 * решения расходятся при первой правке, и расходятся молча: колонки просто
 * перестают быть одной высоты.
 */
const WORKSPACE_HEIGHT = '72vh';
const WORKSPACE_MIN_HEIGHT = 420;

export function MarkupScreen({ revisionId }: MarkupScreenProps): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();

  const revisions = useQuery({
    queryKey: layoutKeys.revisions(revisionId),
    queryFn: () => layout.listRevisions(revisionId),
  });

  useEvidenceTarget();
  usePdfCacheCleanup();

  /**
   * Разметка одна, и выбирать нечего.
   *
   * Прежде здесь стоял выпадающий список «Ревизия 3 — Заморожена»: повторное
   * выделение блоков заводило следующую ревизию разметки, и человеку приходилось
   * держать в голове, какая из них сейчас настоящая. Теперь разметка у поставки
   * одна и всегда правимая, поэтому берётся последняя — она же единственная.
   */
  const layoutId = revisions.data?.[revisions.data.length - 1]?.id ?? null;

  if (revisions.isPending) return <LoadingState label="Загрузка разметки…" />;
  if (revisions.isError) return <ErrorState error={revisions.error} />;
  if (layoutId === null) {
    return (
      <Alert
        type="info"
        showIcon
        message="Разметки ещё нет"
        description={
          'Разметка создаётся кнопкой «1. Выделить блоки» над вкладками: ' +
          'она собирает рабочий документ и запускает постраничную детекцию.'
        }
      />
    );
  }

  return (
    <LayoutWorkspace
      key={layoutId}
      revisionId={revisionId}
      layoutId={layoutId}
      canEdit={can('markup.edit')}
      canRecognize={can('recognition.start')}
      canLabelPages={can('document.edit')}
      onAfterRecognize={() => {
        void queryClient.invalidateQueries({
          queryKey: revisionKeys.recognitionRuns(revisionId),
        });
      }}
      notify={message}
    />
  );
}

interface WorkspaceProps {
  readonly revisionId: string;
  readonly layoutId: string;
  readonly canEdit: boolean;
  readonly canRecognize: boolean;
  /** Право `document.edit`: ручная метка типа страницы (§8.2), не связана с правкой блоков. */
  readonly canLabelPages: boolean;
  readonly onAfterRecognize: () => void;
  readonly notify: ReturnType<typeof AntApp.useApp>['message'];
}

function LayoutWorkspace(props: WorkspaceProps): ReactNode {
  const { revisionId, layoutId, canEdit, canRecognize, canLabelPages, notify } = props;

  const detail = useQuery({
    queryKey: layoutKeys.detail(layoutId),
    queryFn: () => layout.detail(layoutId),
  });
  const blockList = useQuery({
    queryKey: layoutKeys.blocks(layoutId),
    queryFn: () => layout.blocks(layoutId),
  });
  const bundleId = detail.data?.bundleId ?? null;
  const pages = useQuery({
    queryKey: revisionKeys.bundlePages(bundleId ?? 'none'),
    queryFn: () => bundles.pages(bundleId ?? ''),
    enabled: bundleId !== null,
  });
  // Классификации и каталог видов ИД — для панели «Тип страницы» и бейджей в
  // ленте. Ключи кэша те же, что на вкладке «Документы»: метка, поставленная
  // здесь, видна там без второй загрузки, и наоборот.
  const classifications = useQuery({
    queryKey: revisionKeys.classifications(revisionId),
    queryFn: () => documents.classifications(revisionId),
  });
  const docTypes = useQuery({
    queryKey: catalogKeys.docTypes(false),
    queryFn: () => catalog.docTypes(false),
  });

  /**
   * Распознанный текст последнего завершённого прогона.
   *
   * Прогон выбирается ЗДЕСЬ, а не на сервере: маршрута «дай текст ревизии» нет,
   * а заводить его ради экрана значило бы решать за все будущие экраны, какой
   * прогон считать настоящим. Список прогонов уже читается вкладкой и
   * обесценивается после нажатия «Распознать».
   */
  const runs = useQuery({
    queryKey: revisionKeys.recognitionRuns(revisionId),
    queryFn: () => recognition.runs(revisionId),
  });
  const latestRunId =
    [...(runs.data ?? [])]
      .filter((run) => run.status === 'done')
      .sort((a, b) => (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt))
      .at(-1)?.id ?? null;
  const pageTexts = useQuery({
    queryKey: recognitionKeys.pages(latestRunId ?? 'none'),
    queryFn: () => recognition.pages(latestRunId ?? ''),
    enabled: latestRunId !== null,
  });
  const blockTexts = useQuery({
    queryKey: recognitionKeys.blocks(latestRunId ?? 'none'),
    queryFn: () => recognition.blocks(latestRunId ?? ''),
    enabled: latestRunId !== null,
  });

  /**
   * Подписка НЕ на всё хранилище, а на срез без масштаба.
   *
   * `useMarkupStore()` без селектора будит компонент на любое `set`, а масштаб
   * теперь непрерывный: Ctrl с колесом меняет его десятки раз в секунду. Без
   * среза каждый щелчок колеса перерисовывал бы ленту из десятков карточек и
   * список блоков — то есть плавный зум стоил бы тем дороже, чем крупнее
   * комплект. Масштаб читает только `CanvasArea`, и читает он его селекторами.
   */
  const store = useMarkupStore(
    useShallow((state) => ({
      workingPageIndex: state.workingPageIndex,
      armedType: state.armedType,
      selection: state.selection,
      columnSizes: state.columnSizes,
      textCollapsed: state.textCollapsed,
      goToPage: state.goToPage,
      armType: state.armType,
      disarm: state.disarm,
      select: state.select,
      toggle: state.toggle,
      clearSelection: state.clearSelection,
      setColumnSizes: state.setColumnSizes,
      toggleTextColumn: state.toggleTextColumn,
      resetColumns: state.resetColumns,
    })),
  );
  const blocks = blockList.data?.items ?? [];
  const editing = useLayoutEditing({
    layoutId,
    serverVersion: blockList.data?.version ?? detail.data?.version ?? 0,
    blocks,
  });

  // Выделение чистится от блоков, которых больше нет: иначе кнопка типа послала
  // бы PATCH на удалённый блок и получила 404.
  //
  // Зависимости эффекта — СТРОКА идентификаторов и отдельно взятое действие
  // хранилища, а не массив блоков и не объект состояния целиком. Первая
  // редакция зависела от `blocks` (новый массив на каждом рендере, пока запрос
  // не отдал данные) и от `store` (весь объект состояния, новый после любого
  // `set`), и это давало бесконечный цикл обновлений: React срывался с
  // «Maximum update depth exceeded», экран разметки не рисовался вовсе, а
  // сквозной прогон видел пустую страницу. Ошибка была не в разметке — она была
  // в паре зависимостей, у каждой из которых нестабильная ссылка.
  //
  // Пока список блоков НЕ ЗАГРУЖЕН, чистить нечем: пустой массив в этот момент
  // означает «ещё не знаем», а не «блоков нет». Ранняя редакция этого не
  // различала и стирала выделение, поставленное адресом доказательства
  // (`?block=` из ссылки замечания, §16): переход открывал нужную страницу, но
  // блок оказывался невыделенным — и выглядело это как «ссылка ведёт не туда».
  const retainExisting = useMarkupStore((state) => state.retainExisting);
  const blockIdsKey =
    blockList.data === undefined ? null : blocks.map((block) => block.id).join(' ');
  useEffect(() => {
    if (blockIdsKey === null) return;
    retainExisting(blockIdsKey === '' ? [] : blockIdsKey.split(' '));
  }, [blockIdsKey, retainExisting]);

  const detect = useMutation({
    mutationFn: (workingPageIndices?: readonly number[]) =>
      layout.detect(layoutId, workingPageIndices),
    onSuccess: (result) =>
      notify.success(`Детекция поставлена в очередь: пачек ${String(result.batches)}`),
    onError: (error) => notify.error(describeError(error)),
  });

  const recognize = useMutation({
    mutationFn: () => recognition.start(revisionId, layoutId),
    onSuccess: (result) => {
      notify.success(
        result.created
          ? 'Комплект отправлен на распознавание'
          : 'Прогон распознавания по этой разметке уже идёт',
      );
      props.onAfterRecognize();
    },
    onError: (error) => notify.error(describeError(error)),
  });

  const orientation = usePageOrientation(revisionId, bundleId);

  /**
   * Ширины колонок и ключ перемонтирования `Splitter`.
   *
   * Splitter остаётся НЕуправляемым (`defaultSize`, не `size`), и это не
   * мелочь: управляемый требует `onResize`, то есть `setState` в этом
   * компоненте на КАЖДЫЙ кадр перетаскивания разделителя — а значит новые
   * элементы ленты из десятков карточек и канвы всю дорогу. В неуправляемом
   * режиме размеры живут внутри antd, дети остаются теми же React-элементами,
   * и React отбрасывает их поддеревья.
   *
   * Плата за это — перемонтирование по `key`, когда набор панелей меняется:
   * `useSizes` держит размеры позиционным массивом, и убранная панель отдала бы
   * свою ширину соседке. Перемонтирование стоит один раз на нажатие, а не раз
   * в кадр, и мигания канвы не даёт — `usePdfPage` берёт готовую канву из кэша
   * синхронно.
   */
  const [resetNonce, setResetNonce] = useState(0);
  /**
   * Доли ВИДИМЫХ панелей: при свёрнутом тексте их три, и сумма обязана остаться
   * сотней, иначе antd растянет остаток по своему усмотрению.
   */
  const panelSizes = store.textCollapsed ? sizesWithoutText(store.columnSizes) : store.columnSizes;
  const splitterKey = `${store.textCollapsed ? 'no-text' : 'with-text'}:${String(resetNonce)}`;

  if (detail.isPending || blockList.isPending) return <LoadingState label="Загрузка разметки…" />;
  if (detail.isError) return <ErrorState error={detail.error} />;
  if (blockList.isError) return <ErrorState error={blockList.error} />;

  const layoutDetail = detail.data;
  /**
   * Разметка правится всегда, пока правится сама поставка.
   *
   * Состояние разметки в это решение больше не входит (0048): заморозки нет, а
   * `superseded` — историческое состояние старых баз, до которого экран не
   * доводит. Осталось одно условие — право.
   */
  const superseded = layoutDetail.state === 'superseded';
  const editable = canEdit && !superseded;
  /**
   * Почему панель инструментов недоступна — текстом, а не молча.
   *
   * Панель рисуется всегда, и `editable` гасит в ней ВСЁ разом: выбор
   * инструмента, тип блока, повтор детекции, замену страницы. Серая панель без
   * объяснения неотличима от неработающего экрана — с этого началось замечание
   * «нет инструментов ручного выделения», хотя инструменты были на месте и
   * просто не были разрешены роли.
   */
  const disabledReason: string | null = superseded
    ? 'Эта ревизия разметки заменена более поздней — правки идут в неё.'
    : canEdit
      ? null
      : 'Недостаточно прав: правка разметки требует markup.edit. ' +
        'Разметку ведут подрядчик, генподрядчик, инженер и администратор.';

  const handleResizeEnd = (sizes: number[]): void => {
    // Пиксели от antd; доли считает чистая функция, она же отвергает мусор.
    const next = store.textCollapsed
      ? mergeSizesWithoutText(store.columnSizes, sizes)
      : pixelsToPercent(sizes);
    if (next !== null) store.setColumnSizes(next);
  };

  const resetColumns = (): void => {
    store.resetColumns();
    setResetNonce((value) => value + 1);
  };

  const toggleTextColumn = (): void => {
    store.toggleTextColumn();
    setResetNonce((value) => value + 1);
  };

  const pageList = pages.data ?? [];
  const currentIndex = Math.max(
    0,
    pageList.findIndex((page) => page.workingPageIndex === store.workingPageIndex),
  );
  const currentPage = pageList[currentIndex];
  // Соседняя страница по ленте — для предзагрузки. Порядок берётся из списка,
  // а не из `workingPageIndex + 1`: индексы рабочего документа плотные, но
  // список — единственный источник соответствия «страница → файл и лист».
  const nextPage = pageList[currentIndex + 1];

  const flagsByPage = new Map<number, readonly AttentionFlag[]>(
    layoutDetail.pages.map((entry) => [entry.workingPageIndex, entry.flags]),
  );
  const blockCountByPage = new Map<number, number>();
  for (const block of blocks) {
    blockCountByPage.set(
      block.workingPageIndex,
      (blockCountByPage.get(block.workingPageIndex) ?? 0) + 1,
    );
  }

  // Классификация привязана к странице ИСХОДНИКА (`sourcePageId`), а лента и
  // канва живут в координатах рабочего документа — карта страниц уже несёт обе
  // стороны соответствия, поэтому здесь только перекладка, без второго запроса.
  const classByPage = new Map<string, PageClassification>(
    (classifications.data ?? []).map((item) => [item.sourcePageId, item]),
  );
  const shortNameByCode = new Map<string, string>(
    (docTypes.data ?? []).map((type) => [type.code, type.shortName]),
  );
  const typeByPage = new Map<number, PageTypeBadge>();
  for (const pageEntry of pageList) {
    const cls = classByPage.get(pageEntry.sourcePageId);
    if (cls === undefined) continue;
    typeByPage.set(pageEntry.workingPageIndex, {
      text:
        cls.label === 'I-DOC'
          ? 'продолжение'
          : cls.docTypeCode === null
            ? // Ярлык без вида — законное состояние открытого мира: показывается
              // код как есть, а не прочерк, за которым его не отличить от «пусто».
              cls.label
            : (shortNameByCode.get(cls.docTypeCode) ?? cls.docTypeCode),
      manual: cls.source === 'manual',
    });
  }

  const pageBlocks = sortedForReading(
    blocks.filter((block) => block.workingPageIndex === (currentPage?.workingPageIndex ?? 0)),
  );
  const ranks = readingRanks(blocks);
  const selectedOnPage = pageBlocks.filter((block) => store.selection.has(block.id));

  // Текст прогона ложится на блоки по `layoutBlockId`, а на страницу — по
  // индексу страницы рабочего документа: обе связи прямые, сопоставлять нечего.
  const currentPageText =
    (pageTexts.data ?? []).find(
      (item) => item.workingPageIndex === (currentPage?.workingPageIndex ?? -1),
    ) ?? null;
  const textByBlock = new Map<string, string>();
  for (const result of blockTexts.data ?? []) {
    if (!result.isCurrent || result.contentMd === null) continue;
    textByBlock.set(result.layoutBlockId, result.contentMd);
  }

  /**
   * Текст ОДНОГО выделенного блока для колонки распознанного текста.
   *
   * Прежде текст каждого блока стоял в списке блоков, а списка больше нет.
   * Возможность от этого не исчезает: проверяют всегда один блок — тот, чью
   * рамку сейчас правят, — и его текст показывается над текстом страницы.
   * При выделении из нескольких показывать нечего: «текст выделенного» тогда
   * означало бы текст произвольного из них.
   */
  const soleSelected = selectedOnPage.length === 1 ? selectedOnPage[0] : undefined;
  const soleSelectedText =
    soleSelected === undefined ? undefined : textByBlock.get(soleSelected.id);
  const selectedBlockText =
    soleSelected === undefined || soleSelectedText === undefined || soleSelectedText.trim() === ''
      ? null
      : {
          title: describeBlock(soleSelected, ranks.get(soleSelected.id) ?? 0),
          text: soleSelectedText,
        };

  /**
   * Кнопка типа делает ОДНО из двух, и выбор зависит только от выделения.
   *
   * Выделен блок — тип меняется у него, немедленно. Выделения нет — тип
   * взводится для обводки, ровно на один блок. Третьего состояния нет
   * намеренно: прежде их было именно три (инструмент, тип, «Применить»), и
   * ошибиться можно было в каждом.
   */
  const pickType = (blockType: BlockType): void => {
    if (selectedOnPage.length > 0) {
      void editing.applyTypeTo(
        selectedOnPage.map((block) => block.id),
        blockType,
      );
      return;
    }
    if (store.armedType === blockType) store.disarm();
    else store.armType(blockType);
  };

  const deleteSelected = (): void => {
    if (selectedOnPage.length === 0) return;
    void editing.deleteBlocks(selectedOnPage.map((block) => block.id));
  };

  return (
    <>
      <MarkupToolbar
        state={layoutDetail.state}
        blocksHash={layoutDetail.blocksHash}
        blockCount={blocks.length}
        coverage={coverageOf(pageBlocks)}
        editable={editable}
        disabledReason={disabledReason}
        busy={editing.busy}
        armedType={store.armedType}
        pageBlocks={pageBlocks}
        ranks={ranks}
        selection={store.selection}
        onPickType={pickType}
        onSelectBlock={store.select}
        onDeleteSelected={deleteSelected}
        onRedetect={() => {
          if (currentPage === undefined) return;
          detect.mutate([currentPage.workingPageIndex]);
        }}
        detecting={detect.isPending}
      />

      {/*
        Три колонки на `Splitter`, и петля раскладки разомкнута ПО ПОСТРОЕНИЮ.

        История, ради которой это написано: до S32 рабочая область была `Row`,
        то есть `flex-flow: row wrap`, а средняя колонка имела flex-basis по
        содержимому. Решение о переносе строки считается по flex base size, и
        `minWidth: 0` на него не влияет вовсе — он влияет только на сжатие уже
        сформированной строки. Ширину раздували то длинная строка распознанного
        текста, то канва на большом масштабе, и картинка уезжала под ленту
        миниатюр: на одной странице комплекта рядом, на соседней вниз. S32
        лечил это `wrap={false}` плюс `flex="1 1 0"` — то есть заставлял
        колонку не зависеть от содержимого руками.

        `Splitter` даёт то же самое сильнее и без уговоров: каждая панель
        получает `flex-grow: 0` с `flex-basis` в пикселях, а `overflow: auto` на
        панели разрешает её автоминимум в ноль. Содержимое ширину панели не
        меняет вообще ничем — ни длинной строкой, ни канвой на 400 %.

        Высота задана ОДИН раз, здесь. Прежде `72vh` стояло в трёх местах
        (обе боковые колонки и контейнер прокрутки канвы) плюс `32vh` у текста,
        и величина, разбросанная по четырём файлам, разъезжается при первой же
        правке.

        Колонок было четыре: последней стоял список блоков с фильтрами. Он ушёл
        целиком — выбор блока, смена типа и удаление переехали в панель
        инструментов, а освободившаяся пятая часть ширины досталась странице и
        распознанному тексту, то есть тому, что рассматривают и читают.
      */}
      <Splitter
        key={splitterKey}
        style={{ marginTop: 12, height: WORKSPACE_HEIGHT, minHeight: WORKSPACE_MIN_HEIGHT }}
        onResizeEnd={handleResizeEnd}
      >
        <Splitter.Panel
          defaultSize={`${String(panelSizes[0] ?? 15)}%`}
          min={COLUMN_MIN.strip}
          max="35%"
        >
          {pages.isPending ? (
            <Spin />
          ) : (
            <ThumbnailStrip
              pages={pageList}
              flagsByPage={flagsByPage}
              blockCountByPage={blockCountByPage}
              typeByPage={typeByPage}
              current={currentPage?.workingPageIndex ?? 0}
              onSelect={store.goToPage}
            />
          )}
        </Splitter.Panel>

        {/*
          Колонка страницы — единственная с `overflow: hidden`.

          У остальных трёх работает штатный `overflow: auto` от antd, и он же
          заменяет прежние `maxHeight: 72vh` на них. Здесь прокрутка ведётся
          собственным контейнером внутри `CanvasArea`, потому что там надо
          мерить доступное место: вторая прокрутка снаружи не добавила бы
          ничего, кроме второй полосы.
        */}
        <Splitter.Panel
          defaultSize={`${String(panelSizes[1] ?? 50)}%`}
          min={COLUMN_MIN.canvas}
          style={{ overflow: 'hidden' }}
        >
          {currentPage === undefined ? (
            <Alert
              type="warning"
              showIcon
              message="У рабочего документа нет карты страниц"
              description="Разметка ложится на страницы рабочего документа; без карты страниц показывать нечего."
            />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
                minWidth: 0,
              }}
            >
              <PageTypePanel
                revisionId={revisionId}
                page={currentPage}
                classification={classByPage.get(currentPage.sourcePageId)}
                docTypes={docTypes.data ?? []}
                canEdit={canLabelPages}
              />
              <CanvasArea
                page={currentPage}
                nextPage={nextPage}
                blocks={pageBlocks}
                ranks={ranks}
                selection={store.selection}
                armedType={store.armedType}
                editable={editable}
                canRotate={canEdit}
                rotationPending={orientation.pending}
                textCollapsed={store.textCollapsed}
                onToggleText={toggleTextColumn}
                onResetColumns={resetColumns}
                onRotate={(quarterTurns) =>
                  orientation.setRotation(
                    currentPage.sourcePageId,
                    rotateBy(normalizeRotation(currentPage.contentRotation), quarterTurns),
                  )
                }
                onResetRotation={() => orientation.clear(currentPage.sourcePageId)}
                onSelect={(blockId, additive) =>
                  additive ? store.toggle(blockId) : store.select(blockId)
                }
                onClearSelection={store.clearSelection}
                onDeleteSelected={deleteSelected}
                onEscape={() => {
                  store.disarm();
                  store.clearSelection();
                }}
                onCreate={(coords) => {
                  if (store.armedType === null) return;
                  void editing.createBlock({
                    workingPageIndex: currentPage.workingPageIndex,
                    blockType: store.armedType,
                    coords,
                  });
                  /*
                    Взвод одноразовый: обведя рамку, человек возвращается к
                    выделению и может тут же поправить её углы. Оставленный
                    включённым, он превращал бы каждый следующий щелчок по листу
                    в новый блок — и заметно это становилось только по мусору в
                    списке, уже после нескольких промахов.
                  */
                  store.disarm();
                }}
                onMove={(blockId, coords) => {
                  void editing.updateBlock(blockId, { coords });
                }}
              />
            </div>
          )}
        </Splitter.Panel>

        {/*
          Колонка распознанного текста рисуется только развёрнутой.

          Свёрнутая панель — это НЕ нулевая ширина: `useSizes` держит размеры
          позиционным массивом, и панель, оставленная в разметке с нулём,
          отдала бы свою запомненную ширину списку блоков. Условный рендер плюс
          смена `key` у `Splitter` переинициализируют размеры честно.

          `collapsible` от antd не используется намеренно: его кнопки несут
          зашитый английский `aria-label` без локали, а экран закрыт гейтом
          доступности. Своя кнопка с русским именем живёт в панели вида.
        */}
        {!store.textCollapsed && (
          <Splitter.Panel defaultSize={`${String(panelSizes[2] ?? 35)}%`} min={COLUMN_MIN.text}>
            <RecognizedText
              text={currentPageText}
              blockText={selectedBlockText}
              pageNumber={(currentPage?.workingPageIndex ?? 0) + 1}
              /*
                `pageTexts` ВЫКЛЮЧЕН, пока завершённого прогона нет, а
                выключенный запрос в TanStack Query навсегда остаётся
                `pending` — то есть `isPending` здесь означал бы «грузится»
                ровно тогда, когда грузить нечего. В коллапсе под канвой это
                было незаметно, в собственной колонке — вечный волчок вместо
                внятного «распознавание ещё не выполнялось».
              */
              loading={runs.isPending || (latestRunId !== null && pageTexts.isPending)}
              hasRun={latestRunId !== null}
            />
          </Splitter.Panel>
        )}
      </Splitter>

      <SendToRecognition
        blockCount={blocks.length}
        canRecognize={canRecognize}
        recognizing={recognize.isPending}
        onRecognize={() => recognize.mutate()}
      />

      {editing.conflict !== null && (
        <VersionConflictModal
          open
          diff={editing.conflict.diff}
          serverVersion={editing.conflict.serverVersion}
          appliedBefore={editing.conflict.appliedBefore}
          onAcceptServer={() => {
            editing.dismissConflict();
            void blockList.refetch();
            void detail.refetch();
          }}
        />
      )}
    </>
  );
}

// =====================================================================
// Область канвы: измерение доступного места и сверка фреймов
// =====================================================================

/** Страница рабочего документа в том виде, в каком её знает канва. */
interface CanvasPage {
  readonly workingPageIndex: number;
  readonly sourcePageId: string;
  readonly sourceFileId: string;
  readonly filePageIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** `/Rotate` из PDF: уже применён и к размерам выше, и к вьюпорту pdf.js. */
  readonly rotation: number;
  /** Разворот скана: не применён никем, применяем его мы (ADR-0020). */
  readonly contentRotation: number;
  readonly contentRotationSource: 'probe' | 'user' | null;
}

interface CanvasAreaProps {
  readonly page: CanvasPage;
  /** Следующая страница ленты — только для предзагрузки; `undefined` на последней. */
  readonly nextPage: CanvasPage | undefined;
  readonly blocks: readonly LayoutBlock[];
  readonly ranks: ReadonlyMap<string, number>;
  readonly selection: ReadonlySet<string>;
  readonly armedType: BlockType | null;
  readonly editable: boolean;
  /** Право менять разворот. Масштаб доступен и без него — это просмотр. */
  readonly canRotate: boolean;
  readonly rotationPending: boolean;
  readonly onRotate: (quarterTurns: 1 | -1) => void;
  readonly onResetRotation: () => void;
  readonly textCollapsed: boolean;
  readonly onToggleText: () => void;
  readonly onResetColumns: () => void;
  readonly onSelect: (blockId: string, additive: boolean) => void;
  readonly onClearSelection: () => void;
  readonly onDeleteSelected: () => void;
  readonly onEscape: () => void;
  readonly onCreate: Parameters<typeof PageCanvas>[0]['onCreate'];
  readonly onMove: Parameters<typeof PageCanvas>[0]['onMove'];
}

function CanvasArea(props: CanvasAreaProps): ReactNode {
  const { page, nextPage } = props;
  const zoomMode = useMarkupStore((state) => state.zoomMode);
  const manualZoom = useMarkupStore((state) => state.zoom);
  const setZoomMode = useMarkupStore((state) => state.setZoomMode);
  const setManualZoom = useMarkupStore((state) => state.setManualZoom);

  const holder = useRef<HTMLDivElement | null>(null);
  const scrollBox = useRef<HTMLDivElement | null>(null);
  /**
   * `null`, пока область не измерена.
   *
   * Раньше здесь стояло `{800, 1000}`, и это давало ДВА рендера каждой
   * страницы: один по выдуманному размеру, второй — по настоящему, как только
   * сработает `ResizeObserver`. Первый всегда выбрасывался, но занимал воркер
   * pdf.js ровно тогда, когда от него ждали вторую отрисовку.
   */
  const [available, setAvailable] = useState<RenderedSize | null>(null);

  const rotation = normalizeRotation(page.contentRotation);

  /**
   * Наблюдается `holder` с `overflow: hidden`, а НЕ панель `Splitter` и не
   * контейнер прокрутки — и это не придирка.
   *
   * У панели `Splitter` штатный `overflow: auto`. Повесив наблюдателя на неё,
   * мы получили бы вторую петлю, тоньше прежней: канва выше панели → появилась
   * вертикальная полоса → `contentRect.width` меньше на её ширину → `fitInto`
   * даёт меньший размер → полоса исчезает → размер растёт. То же и с самим
   * контейнером прокрутки. `holder` скрывает переполнение, поэтому его размер
   * задаётся ТОЛЬКО флексом снаружи и от содержимого не зависит вовсе.
   *
   * Высота теперь настоящая, из `contentRect`, а не `window.innerHeight * 0.72`:
   * доля окна была догадкой о высоте колонки, а колонка стала измеримой.
   */
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setAvailable({
        width: Math.max(200, entry.contentRect.width),
        height: Math.max(200, entry.contentRect.height),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * Две системы размеров, и путать их нельзя.
   *
   * `content` — размер НЕповёрнутого содержимого: та система, в которой заданы
   * `coords_norm`, и та, в которой pdf.js рисует канву. `display` — то, что
   * видно на экране: при развороте на четверть у него переставлены стороны.
   * Вписывание считается по `display` (иначе повёрнутый лист не влезал бы в
   * колонку), а ширина рендера pdf.js — по `content`.
   */
  const displayFrame = applyRotation({ width: page.widthPx, height: page.heightPx }, rotation);
  const fittedDisplay = useMemo(
    () => (available === null ? null : fitInto(displayFrame, available)),
    [displayFrame.width, displayFrame.height, available],
  );

  const zoom =
    fittedDisplay === null || available === null
      ? 1
      : effectiveZoom(zoomMode, manualZoom, fittedDisplay, available);

  const display: RenderedSize =
    fittedDisplay === null
      ? { width: 0, height: 0 }
      : {
          width: Math.max(80, fittedDisplay.width * zoom),
          height: Math.max(80, fittedDisplay.height * zoom),
        };
  const content = applyRotation(display, rotation);

  const contentUrl = filesApi.contentUrl(page.sourceFileId);
  const rendered = usePdfPage(
    fittedDisplay === null
      ? null
      : {
          fileId: page.sourceFileId,
          contentUrl,
          filePageIndex: page.filePageIndex,
          displayWidth: content.width,
        },
  );

  /**
   * Ctrl + колесо — НЕПАССИВНЫМ слушателем, и это обязательное условие.
   *
   * React вешает `wheel` на корень контейнера пассивно, поэтому
   * `preventDefault()` внутри `onWheel` молча не срабатывает: браузер
   * масштабирует страницу целиком, а канва получает ещё и свой зум. Вышло бы
   * хуже, чем без функции вовсе, — и «иногда работает» в зависимости от того,
   * где оказался курсор.
   */
  const pendingAnchor = useRef<{
    readonly before: RenderedSize;
    readonly pointerX: number;
    readonly pointerY: number;
  } | null>(null);

  useEffect(() => {
    const box = scrollBox.current;
    if (box === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = box.getBoundingClientRect();
      pendingAnchor.current = {
        before: { width: display.width, height: display.height },
        pointerX: event.clientX - rect.left,
        pointerY: event.clientY - rect.top,
      };
      const factor = event.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      setManualZoom(clampZoom(zoom * factor));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [display.width, display.height, zoom, setManualZoom]);

  /**
   * Точка под курсором остаётся под курсором.
   *
   * `useLayoutEffect`, а не `useEffect`: иначе кадр с уже выросшим, но ещё не
   * прокрученным содержимым успевает отрисоваться, и зум заметно дёргается.
   */
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    const box = scrollBox.current;
    pendingAnchor.current = null;
    if (anchor === null || box === null) return;
    const next = anchoredScroll({
      scrollLeft: box.scrollLeft,
      scrollTop: box.scrollTop,
      pointerX: anchor.pointerX,
      pointerY: anchor.pointerY,
      before: anchor.before,
      after: { width: display.width, height: display.height },
    });
    box.scrollLeft = next.left;
    box.scrollTop = next.top;
  }, [display.width, display.height]);

  /**
   * Панорама — прокруткой контейнера, а не движением сцены Konva.
   *
   * Двигать `Stage` нельзя: исчезли бы полосы прокрутки, сломался бы клампинг
   * указателя по размеру содержимого и появилась бы вторая, невидимая система
   * координат поверх той, в которой заданы блоки. Прокрутка контейнера
   * координатам не видна вовсе.
   */
  const panFrom = useRef<{
    readonly x: number;
    readonly y: number;
    readonly left: number;
    readonly top: number;
  } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setSpaceHeld(true);
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const beginPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const box = scrollBox.current;
    // Средняя кнопка либо пробел с левой. Левая без модификатора остаётся за
    // рисованием и выделением рамок: иначе промах мышью панорамировал бы лист
    // вместо создания блока.
    if (box === null || (event.button !== 1 && !(event.button === 0 && spaceHeld))) return;
    event.preventDefault();
    panFrom.current = {
      x: event.clientX,
      y: event.clientY,
      left: box.scrollLeft,
      top: box.scrollTop,
    };
    setPanning(true);
    box.setPointerCapture(event.pointerId);
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const from = panFrom.current;
    const box = scrollBox.current;
    if (from === null || box === null) return;
    box.scrollLeft = from.left - (event.clientX - from.x);
    box.scrollTop = from.top - (event.clientY - from.y);
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (panFrom.current === null) return;
    panFrom.current = null;
    setPanning(false);
    scrollBox.current?.releasePointerCapture(event.pointerId);
  };

  /**
   * Предзагрузка следующей страницы — после того, как текущая показана.
   *
   * Условие `rendered.page !== null` существенно: запущенная раньше,
   * предзагрузка встала бы в очередь к тому же воркеру ПЕРЕД страницей,
   * которую человек уже ждёт, и сделала бы переключение медленнее, а не
   * быстрее.
   */
  useEffect(() => {
    if (nextPage === undefined || rendered.page === null || available === null) return;
    // Соседняя страница вписывается СВОИМИ размерами и СВОИМ разворотом: у
    // альбомной A3 после портретной A4 ширина показа другая. А ширина РЕНДЕРА
    // считается от неповёрнутого содержимого — иначе предзагрузка легла бы мимо
    // ключа кэша, то есть отрисовала бы страницу, которую никто не возьмёт.
    const nextRotation = normalizeRotation(nextPage.contentRotation);
    const nextFitted = fitInto(
      applyRotation({ width: nextPage.widthPx, height: nextPage.heightPx }, nextRotation),
      available,
    );
    const nextContent = applyRotation(
      {
        width: Math.max(80, nextFitted.width * zoom),
        height: Math.max(80, nextFitted.height * zoom),
      },
      nextRotation,
    );
    prefetchPage({
      fileId: nextPage.sourceFileId,
      contentUrl: filesApi.contentUrl(nextPage.sourceFileId),
      filePageIndex: nextPage.filePageIndex,
      renderWidth: renderWidthFor(nextContent.width),
    });
  }, [nextPage, rendered.page, available, zoom]);

  /**
   * Сверка фреймов, а не поворот координат.
   *
   * Сравниваются НЕповёрнутый фрейм карты страниц и НЕповёрнутый вьюпорт
   * pdf.js. `contentRotation` сюда НЕ входит и входить не должен: он не меняет
   * ни `widthPx`/`heightPx`, ни вьюпорт — он поправка к тому, что НАРИСОВАНО
   * внутри этого фрейма. Соблазн «повернуть и здесь тоже, для единообразия»
   * велик, а результат — падение проверки целостности на каждой странице,
   * которую инженер развернул, то есть проверка превращается в шум.
   *
   * Расхождение же означает, что одна из сторон применила `/Rotate` дважды или
   * не применила вовсе, и рамки лягут мимо — но молча. Поэтому оно показывается.
   */
  const mismatch =
    rendered.page !== null &&
    !framesAgree({ width: page.widthPx, height: page.heightPx }, rendered.page.naturalSize);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0',
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <CanvasViewBar
        zoomMode={zoomMode}
        zoomPercent={Math.round(zoom * 100)}
        onZoomStep={(direction) => setManualZoom(stepZoom(zoom, direction))}
        onZoomMode={setZoomMode}
        rotation={rotation}
        rotationSource={page.contentRotationSource}
        canRotate={props.canRotate}
        rotationPending={props.rotationPending}
        onRotate={props.onRotate}
        onResetRotation={props.onResetRotation}
        textCollapsed={props.textCollapsed}
        onToggleText={props.onToggleText}
        onResetColumns={props.onResetColumns}
      />

      {/*
        Алерты — СНАРУЖИ измеряемого `holder`.

        Внутри их появление меняло бы измеряемую высоту, то есть доступное
        канве место зависело бы от того, есть ли сейчас ошибка.
      */}
      {mismatch && (
        <Alert
          type="error"
          showIcon
          data-testid="frame-mismatch"
          message="Фрейм страницы не совпадает с картой рабочего документа"
          description={`Карта страниц: ${String(page.widthPx)}×${String(page.heightPx)}, /Rotate ${String(page.rotation)}°, разворот содержимого ${String(rotation)}°; pdf.js: ${String(Math.round(rendered.page?.naturalSize.width ?? 0))}×${String(Math.round(rendered.page?.naturalSize.height ?? 0))}. Координаты блоков в этом состоянии показывать нельзя.`}
          style={{ marginBottom: 8 }}
        />
      )}
      {rendered.error !== null && (
        <Alert
          type="error"
          showIcon
          message="Страница не отрисована"
          description={describeError(rendered.error)}
          style={{ marginBottom: 8 }}
        />
      )}

      <div ref={holder} style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        <div
          ref={scrollBox}
          onPointerDown={beginPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            overflow: 'auto',
            // Зазор полосы прокрутки постоянен: иначе «по ширине» то показывал
            // бы полосу, то прятал её, меняя доступную ширину туда-сюда.
            scrollbarGutter: 'stable',
            ...(spaceHeld ? { cursor: panning ? 'grabbing' : 'grab' } : {}),
          }}
        >
          {rendered.loading && (
            <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 2 }}>
              <Spin size="small" />
            </div>
          )}
          {!mismatch && (
            <PageCanvas
              content={content}
              rotation={rotation}
              image={rendered.page?.canvas ?? null}
              blocks={props.blocks}
              ranks={props.ranks}
              selection={props.selection}
              armedType={props.armedType}
              editable={props.editable}
              workingPageIndex={page.workingPageIndex}
              onSelect={props.onSelect}
              onClearSelection={props.onClearSelection}
              onDeleteSelected={props.onDeleteSelected}
              onEscape={props.onEscape}
              onCreate={props.onCreate}
              onMove={props.onMove}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Панель инструментов
// =====================================================================

/**
 * Панель инструментов: всё управление блоками в одну строку.
 *
 * ## Почему тип блока стал КНОПКОЙ, а не значением селекта
 *
 * Прежде смена типа одной рамки стоила четырёх движений в трёх местах: выделить
 * блок на канве, найти селект «Тип блока», выбрать в нём значение, нажать
 * «Применить тип к выделенным». Три из четырёх шагов не относились к делу — они
 * обслуживали механизм, а не задачу. Причём тот же селект отвечал ещё и за тип
 * НОВОГО блока, то есть одно поле означало два разных «типа» в зависимости от
 * положения соседнего переключателя «Выделять / Рисовать».
 *
 * Теперь состояние ровно одно — есть выделение или нет, — и кнопка типа читает
 * его сама:
 *
 * - выделение есть → тип меняется у выделенного, сразу;
 * - выделения нет → тип взводится для обводки, ровно на один блок.
 *
 * Взвод виден подсветкой самой кнопки, поэтому отдельного индикатора режима
 * не нужно: переключатель инструмента и был таким индикатором, и именно он
 * расходился с селектом типа.
 *
 * ## Почему у удаления нет подтверждения
 *
 * `Popconfirm` на каждой поправке рамки — это и есть та тяжесть, ради которой
 * панель переделывалась. Блок восстанавливается обводкой за секунду или
 * повтором детекции страницы; цена ошибочного удаления несоизмерима с ценой
 * лишнего диалога на каждое из десятков движений разметки. Разрушительные
 * пакетные операции («заменить страницу одним блоком», профиль full-page-text)
 * из портала убраны совсем — вместе с их подтверждениями.
 */
interface ToolbarProps {
  readonly state: 'draft' | 'superseded';
  readonly blocksHash: string | null;
  readonly blockCount: number;
  readonly coverage: number;
  readonly editable: boolean;
  /** Почему панель недоступна; `null` — доступна. Показывается рядом с кнопками. */
  readonly disabledReason: string | null;
  readonly busy: boolean;
  /** Взведённый тип обводки; `null` — обычный режим. */
  readonly armedType: BlockType | null;
  /** Блоки ТЕКУЩЕЙ страницы в порядке чтения — для выбора блока списком. */
  readonly pageBlocks: readonly LayoutBlock[];
  readonly ranks: ReadonlyMap<string, number>;
  readonly selection: ReadonlySet<string>;
  readonly detecting: boolean;
  readonly onPickType: (blockType: BlockType) => void;
  readonly onSelectBlock: (blockId: string) => void;
  readonly onDeleteSelected: () => void;
  readonly onRedetect: () => void;
}

const BLOCK_TYPES: readonly BlockType[] = ['text', 'image', 'stamp'];

function MarkupToolbar(props: ToolbarProps): ReactNode {
  const selectedOnPage = props.pageBlocks.filter((block) => props.selection.has(block.id));
  const nothingSelected = selectedOnPage.length === 0;
  /**
   * Значение выбора блока: только когда выделен ровно один.
   *
   * При выделении из нескольких поле остаётся пустым, а сколько их — сказано
   * рядом словами. Показывать в нём «первый из трёх» значило бы утверждать, что
   * кнопка типа сработает по нему одному.
   */
  const soleSelected = selectedOnPage.length === 1 ? selectedOnPage[0] : undefined;

  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '8px 12px',
        border: '1px solid #f0f0f0',
        borderRadius: 6,
        background: '#fafafa',
      }}
    >
      {/*
        Выбора разметки здесь больше нет: она одна. Тег состояния остался — он
        отвечает на вопрос «почему нельзя править», а не «какую из них я смотрю».
      */}
      <Tag color={props.state === 'draft' ? 'blue' : 'default'}>
        {LAYOUT_STATE_LABELS[props.state]}
      </Tag>
      <Typography.Text type="secondary">
        блоков: {props.blockCount}, покрытие страницы {Math.round(props.coverage * 100)}%
      </Typography.Text>
      {props.blocksHash !== null && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          blocks_hash {props.blocksHash.slice(0, 12)}…
        </Typography.Text>
      )}

      {/*
        Выбор блока списком — путь к рамке МИМО канвы.

        Элементы Konva живут в `<canvas>` и недостижимы ни фокусу, ни
        скринридеру по построению. Раньше этот путь давали чекбоксы колонки
        блоков; колонки больше нет, и обязанность перешла сюда. Подписи те же
        (`describeBlock`), поэтому «третий блок» на канве и «третий блок» в
        списке — один и тот же блок, названный одинаково.
      */}
      <Space size={6}>
        <Typography.Text type="secondary">Блок:</Typography.Text>
        {/*
          Метка стоит на ОБЁРТКЕ: antd не проносит `data-*` до корня `Select`,
          и повешенный на сам компонент атрибут просто исчезает из разметки —
          молча, без предупреждения сборки.
        */}
        <span data-testid="selected-block">
          <Select<string>
            size="small"
            style={{ width: 240 }}
            aria-label="Блок страницы"
            placeholder={props.pageBlocks.length === 0 ? 'Блоков нет' : 'Выбрать блок'}
            disabled={props.pageBlocks.length === 0}
            value={soleSelected?.id ?? null}
            onChange={props.onSelectBlock}
            options={props.pageBlocks.map((block) => ({
              value: block.id,
              label: describeBlock(block, props.ranks.get(block.id) ?? 0),
            }))}
          />
        </span>
        {selectedOnPage.length > 1 && (
          <Typography.Text type="secondary">выделено: {selectedOnPage.length}</Typography.Text>
        )}
      </Space>

      <Space size={6} wrap>
        {BLOCK_TYPES.map((type) => (
          <Tooltip
            key={type}
            title={
              nothingSelected
                ? `Обвести новый блок: ${BLOCK_STYLES[type].label}`
                : `Сменить тип выделенного на «${BLOCK_STYLES[type].label}»`
            }
          >
            <Button
              size="small"
              type={props.armedType === type ? 'primary' : 'default'}
              disabled={!props.editable || props.busy}
              onClick={() => props.onPickType(type)}
            >
              {/*
                Цвет — не единственный признак типа: рядом стоит подпись, а на
                канве у рамки ещё и штриховка. Точка здесь связывает кнопку с
                цветом её рамки, но ничего не сообщает в одиночку.
              */}
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  marginRight: 6,
                  background: BLOCK_STYLES[type].stroke,
                }}
              />
              {BLOCK_STYLES[type].label}
            </Button>
          </Tooltip>
        ))}
        <Tooltip title="Удалить выделенные блоки (Delete)">
          <Button
            size="small"
            danger
            disabled={!props.editable || nothingSelected || props.busy}
            onClick={props.onDeleteSelected}
          >
            Удалить
          </Button>
        </Tooltip>
        <Button
          size="small"
          disabled={!props.editable || props.detecting}
          onClick={props.onRedetect}
        >
          Повторить детекцию страницы
        </Button>
      </Space>

      {/*
        Масштаба здесь больше нет — он переехал в панель вида над канвой.

        Причина в правах: вся эта панель гасится флагом `editable`
        (`markup.edit`), а масштаб — действие ПРОСМОТРА. Проверяющий без права
        правки обязан уметь приблизить штамп, иначе он не может выполнить
        собственную работу.
      */}

      {/*
        Двойное значение кнопки типа — текстом.

        Оно не угадывается: кнопка выглядит одинаково в обоих случаях, а
        различает их состояние выделения, которое живёт на канве. Строка стоит
        под кнопками (`flexBasis: '100%'`), а не в подсказке, потому что
        подсказку читают уже после того, как нажали не то.
      */}
      <Typography.Text type="secondary" style={{ flexBasis: '100%', fontSize: 12 }}>
        {nothingSelected
          ? 'Блок не выделен: кнопка типа один раз включает обводку нового блока этим типом. Клик по рамке выделяет её.'
          : 'Блок выделен: кнопка типа меняет его тип, углы рамки тянутся мышью, Delete удаляет. Esc снимает выделение.'}
      </Typography.Text>

      {props.disabledReason !== null && (
        // `flexBasis: '100%'` — причина занимает свою строку под кнопками:
        // втиснутая между ними, она читалась бы как подпись к соседней.
        <Typography.Text
          type="secondary"
          data-testid="markup-disabled-reason"
          style={{ flexBasis: '100%' }}
        >
          {props.disabledReason}
        </Typography.Text>
      )}
    </div>
  );
}

// =====================================================================
// Нижняя панель: отправка на распознавание (§6.2)
// =====================================================================

/**
 * Кнопка одна, и заморозки перед ней больше нет (0048).
 *
 * Прежде здесь стояли две кнопки подряд: сначала «Заморозить разметку», и
 * только после неё появлялась «Отправить на распознавание». Заморозка была
 * необратимой — поправить рамку после неё было нельзя ничем, кроме полной
 * переразметки. Теперь прогон сам снимает хэш набора блоков на старте, поэтому
 * отправлять можно сколько угодно раз: поправил — отправил снова.
 */
function SendToRecognition(props: {
  readonly blockCount: number;
  readonly canRecognize: boolean;
  readonly recognizing: boolean;
  readonly onRecognize: () => void;
}): ReactNode {
  return (
    <div
      style={{
        marginTop: 12,
        padding: '10px 12px',
        borderTop: '1px solid #f0f0f0',
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      {/* Текст нейтрален к провайдеру: сверка хэшей с RD WEB — деталь одной из
          веток, а не свойство распознавания вообще (ADR-0007). */}
      <Typography.Text type="secondary">
        Распознавание идёт по текущему набору блоков; провайдер и модель задаются в настройках
        портала. Блоки можно править и отправлять на распознавание повторно.
      </Typography.Text>
      <Button
        type="primary"
        data-testid="send-to-recognition"
        loading={props.recognizing}
        disabled={!props.canRecognize || props.blockCount === 0}
        onClick={props.onRecognize}
      >
        Отправить на распознавание
      </Button>
    </div>
  );
}

/**
 * Адрес доказательства: `?page=` и `?block=` из ссылки замечания (§16).
 *
 * Применяется ОДИН раз за монтирование экрана. Иначе любой переход на другую
 * страницу тут же откатывался бы обратно к странице из адреса, и лента миниатюр
 * стала бы неработающей — дефект, который выглядит как «канва не листается».
 */
function useEvidenceTarget(): void {
  const pageParam = useQueryParam('page');
  const blockParam = useQueryParam('block');
  const goToPage = useMarkupStore((state) => state.goToPage);
  const select = useMarkupStore((state) => state.select);
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;
    if (pageParam === null && blockParam === null) return;
    applied.current = true;

    if (pageParam !== null) {
      const index = Number(pageParam);
      if (Number.isInteger(index) && index >= 0) goToPage(index);
    }
    // Выделение ставится ПОСЛЕ перехода на страницу: `goToPage` снимает
    // выделение намеренно (иначе «применить к выделенным» задело бы блоки
    // страницы, которую пользователь уже не видит).
    if (blockParam !== null && blockParam !== '') select(blockParam);
  }, [pageParam, blockParam, goToPage, select]);
}

/**
 * Освобождение памяти pdf.js при уходе с экрана: документы и отрисованные страницы.
 *
 * Кэш документов держит открытый `PDFDocumentProxy` на каждый файл комплекта
 * вместе с его воркером и распакованными объектами; кэш страниц —
 * отрисованные канвы. Без освобождения вкладка, в которой инженер посмотрел
 * десять поставок, удерживает страницы всех десяти: это настоящая утечка, а не
 * теоретическая — на сканах A3 счёт идёт на сотни мегабайт.
 *
 * Содержимое файла неизменяемо (§3.3), поэтому повторное открытие того же файла
 * стоит только чтения xref заново — цена, которую платят один раз за возврат на
 * экран, а не постоянно за всё время жизни вкладки.
 */
function usePdfCacheCleanup(): void {
  useEffect(
    () => () => {
      clearPageCache();
      void closeDocuments();
    },
    [],
  );
}
