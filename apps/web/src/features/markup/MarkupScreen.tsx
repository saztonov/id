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
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Col,
  Popconfirm,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
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
import { BlockList } from './BlockList.js';
import { PageCanvas } from './PageCanvas.js';
import { PageTypePanel } from './PageTypePanel.js';
import { ThumbnailStrip, type PageTypeBadge } from './ThumbnailStrip.js';
import { VersionConflictModal } from './VersionConflictModal.js';
import { applyFilter, coverageOf, readingRanks, sortedForReading, BLOCK_STYLES } from './blocks.js';
import { framesAgree, fitInto, type RenderedSize } from './geometry.js';
import { closeDocuments } from './pdf/pdfjs.js';
import { renderWidthFor } from './pdf/render-width.js';
import { clearPageCache, prefetchPage, usePdfPage } from './pdf/usePdfPage.js';
import { useLayoutEditing } from './useLayoutEditing.js';
import { useMarkupStore, ZOOM_STEPS } from './store.js';

export interface MarkupScreenProps {
  readonly revisionId: string;
}

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

  const store = useMarkupStore();
  const blocks = blockList.data?.items ?? [];
  const editing = useLayoutEditing({
    layoutId,
    serverVersion: blockList.data?.version ?? detail.data?.version ?? 0,
    blocks,
  });

  // Выделение чистится от блоков, которых больше нет: иначе «применить тип к
  // выделенным» посылала бы PATCH на удалённый блок и получала 404.
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
  const visibleBlocks = applyFilter(pageBlocks, store.filter, store.selection);
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

  return (
    <>
      <MarkupToolbar
        state={layoutDetail.state}
        revisionNo={layoutDetail.revisionNo}
        blocksHash={layoutDetail.blocksHash}
        blockCount={blocks.length}
        coverage={coverageOf(pageBlocks)}
        layoutId={layoutId}
        editable={editable}
        disabledReason={disabledReason}
        busy={editing.busy}
        draftType={store.draftType}
        tool={store.tool}
        zoom={store.zoom}
        selectedCount={selectedOnPage.length}
        manuallyEdited={layoutDetail.manuallyEdited}
        onToolChange={store.setTool}
        onDraftTypeChange={store.setDraftType}
        onZoomChange={store.setZoom}
        onApplyTypeToSelected={() => {
          void editing.applyTypeTo(
            selectedOnPage.map((block) => block.id),
            store.draftType,
          );
        }}
        onDeleteSelected={() => {
          void editing.deleteBlocks(selectedOnPage.map((block) => block.id));
        }}
        onReplacePage={() => {
          if (currentPage === undefined) return;
          void editing.replacePageWithText(currentPage.workingPageIndex);
        }}
        onFullPageProfile={() => {
          void editing.applyFullPageProfile();
        }}
        onRedetect={() => {
          if (currentPage === undefined) return;
          detect.mutate([currentPage.workingPageIndex]);
        }}
        detecting={detect.isPending}
      />

      <Row gutter={12} style={{ marginTop: 12 }}>
        <Col flex="240px" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
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
        </Col>

        <Col flex="auto" style={{ minWidth: 0 }}>
          {currentPage === undefined ? (
            <Alert
              type="warning"
              showIcon
              message="У рабочего документа нет карты страниц"
              description="Разметка ложится на страницы рабочего документа; без карты страниц показывать нечего."
            />
          ) : (
            <>
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
                tool={store.tool}
                draftType={store.draftType}
                zoom={store.zoom}
                editable={editable}
                onSelect={(blockId, additive) =>
                  additive ? store.toggle(blockId) : store.select(blockId)
                }
                onClearSelection={store.clearSelection}
                onCreate={(coords) => {
                  void editing.createBlock({
                    workingPageIndex: currentPage.workingPageIndex,
                    blockType: store.draftType,
                    coords,
                  });
                }}
                onMove={(blockId, coords) => {
                  void editing.updateBlock(blockId, { coords });
                }}
              />
              <RecognizedText
                text={currentPageText}
                loading={runs.isPending || pageTexts.isPending}
                hasRun={latestRunId !== null}
              />
            </>
          )}
        </Col>

        <Col flex="300px" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
          <BlockList
            blocks={pageBlocks}
            visible={visibleBlocks}
            ranks={ranks}
            selection={store.selection}
            filter={store.filter}
            textByBlock={textByBlock}
            onFilterChange={store.setFilter}
            onToggle={store.toggle}
            onSelectMany={store.selectMany}
          />
        </Col>
      </Row>

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
  readonly sourceFileId: string;
  readonly filePageIndex: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly rotation: number;
}

interface CanvasAreaProps {
  readonly page: CanvasPage;
  /** Следующая страница ленты — только для предзагрузки; `undefined` на последней. */
  readonly nextPage: CanvasPage | undefined;
  readonly blocks: readonly LayoutBlock[];
  readonly ranks: ReadonlyMap<string, number>;
  readonly selection: ReadonlySet<string>;
  readonly tool: 'select' | 'draw';
  readonly draftType: BlockType;
  readonly zoom: number;
  readonly editable: boolean;
  readonly onSelect: (blockId: string, additive: boolean) => void;
  readonly onClearSelection: () => void;
  readonly onCreate: Parameters<typeof PageCanvas>[0]['onCreate'];
  readonly onMove: Parameters<typeof PageCanvas>[0]['onMove'];
}

function CanvasArea(props: CanvasAreaProps): ReactNode {
  const { page, zoom, nextPage } = props;
  const holder = useRef<HTMLDivElement | null>(null);
  /**
   * `null`, пока область не измерена.
   *
   * Раньше здесь стояло `{800, 1000}`, и это давало ДВА рендера каждой
   * страницы: один по выдуманному размеру, второй — по настоящему, как только
   * сработает `ResizeObserver`. Первый всегда выбрасывался, но занимал воркер
   * pdf.js ровно тогда, когда от него ждали вторую отрисовку.
   */
  const [available, setAvailable] = useState<RenderedSize | null>(null);

  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setAvailable({
        width: Math.max(200, entry.contentRect.width),
        height: Math.max(200, window.innerHeight * 0.72),
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fitted = useMemo(
    () =>
      available === null
        ? null
        : fitInto({ width: page.widthPx, height: page.heightPx }, available),
    [page.widthPx, page.heightPx, available],
  );

  /**
   * Размер показа. Считается из карты страниц, а не из результата рендера:
   * иначе рамки прыгали бы в момент, когда канва доезжает, — а карта страниц
   * известна сразу и является той же системой координат, в которой заданы
   * блоки.
   */
  const size: RenderedSize =
    fitted === null
      ? { width: 0, height: 0 }
      : { width: Math.max(80, fitted.width * zoom), height: Math.max(80, fitted.height * zoom) };

  const contentUrl = filesApi.contentUrl(page.sourceFileId);
  const rendered = usePdfPage(
    fitted === null
      ? null
      : {
          fileId: page.sourceFileId,
          contentUrl,
          filePageIndex: page.filePageIndex,
          displayWidth: size.width,
        },
  );

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
    // Соседняя страница вписывается в область СВОИМИ размерами: у альбомной
    // A3 после портретной A4 ширина показа другая, и предзагрузка по ширине
    // текущей страницы легла бы мимо ключа кэша — то есть отрисовала бы
    // страницу, которую потом никто не возьмёт.
    const nextFitted = fitInto({ width: nextPage.widthPx, height: nextPage.heightPx }, available);
    prefetchPage({
      fileId: nextPage.sourceFileId,
      contentUrl: filesApi.contentUrl(nextPage.sourceFileId),
      filePageIndex: nextPage.filePageIndex,
      renderWidth: renderWidthFor(Math.max(80, nextFitted.width * zoom)),
    });
  }, [nextPage, rendered.page, available, zoom]);

  // Сверка фреймов, а не поворот координат: расхождение означает, что одна из
  // сторон применила /Rotate дважды или не применила вовсе, и рамки лягут мимо —
  // но молча. Поэтому оно показывается.
  const mismatch =
    rendered.page !== null &&
    !framesAgree({ width: page.widthPx, height: page.heightPx }, rendered.page.naturalSize);

  return (
    <div ref={holder} style={{ minWidth: 0 }}>
      {mismatch && (
        <Alert
          type="error"
          showIcon
          data-testid="frame-mismatch"
          message="Фрейм страницы не совпадает с картой рабочего документа"
          description={`Карта страниц: ${String(page.widthPx)}×${String(page.heightPx)}, поворот ${String(page.rotation)}°; pdf.js: ${String(Math.round(rendered.page?.naturalSize.width ?? 0))}×${String(Math.round(rendered.page?.naturalSize.height ?? 0))}. Координаты блоков в этом состоянии показывать нельзя.`}
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
      <div style={{ position: 'relative', overflow: 'auto', maxHeight: '72vh' }}>
        {rendered.loading && (
          <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 2 }}>
            <Spin size="small" />
          </div>
        )}
        {!mismatch && (
          <PageCanvas
            size={size}
            image={rendered.page?.canvas ?? null}
            blocks={props.blocks}
            ranks={props.ranks}
            selection={props.selection}
            tool={props.tool}
            draftType={props.draftType}
            editable={props.editable}
            workingPageIndex={page.workingPageIndex}
            onSelect={props.onSelect}
            onClearSelection={props.onClearSelection}
            onCreate={props.onCreate}
            onMove={props.onMove}
          />
        )}
      </div>
    </div>
  );
}

// =====================================================================
// Панель инструментов
// =====================================================================

interface ToolbarProps {
  readonly state: 'draft' | 'superseded';
  readonly revisionNo: number;
  readonly blocksHash: string | null;
  readonly blockCount: number;
  readonly coverage: number;
  readonly layoutId: string;
  readonly editable: boolean;
  /** Почему панель недоступна; `null` — доступна. Показывается рядом с кнопками. */
  readonly disabledReason: string | null;
  readonly busy: boolean;
  readonly draftType: BlockType;
  readonly tool: 'select' | 'draw';
  readonly zoom: number;
  readonly selectedCount: number;
  readonly manuallyEdited: boolean;
  readonly detecting: boolean;
  readonly onToolChange: (tool: 'select' | 'draw') => void;
  readonly onDraftTypeChange: (blockType: BlockType) => void;
  readonly onZoomChange: (zoom: number) => void;
  readonly onApplyTypeToSelected: () => void;
  readonly onDeleteSelected: () => void;
  readonly onReplacePage: () => void;
  readonly onFullPageProfile: () => void;
  readonly onRedetect: () => void;
}

function MarkupToolbar(props: ToolbarProps): ReactNode {
  const nothingSelected = props.selectedCount === 0;
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

      <Segmented<'select' | 'draw'>
        size="small"
        value={props.tool}
        onChange={props.onToolChange}
        disabled={!props.editable}
        options={[
          { label: 'Выделять', value: 'select' },
          { label: 'Рисовать', value: 'draw' },
        ]}
        aria-label="Инструмент канвы"
      />
      <Select<BlockType>
        size="small"
        value={props.draftType}
        onChange={props.onDraftTypeChange}
        disabled={!props.editable}
        style={{ width: 150 }}
        aria-label="Тип блока"
        options={(['text', 'image', 'stamp'] as BlockType[]).map((type) => ({
          value: type,
          label: BLOCK_STYLES[type].label,
        }))}
      />
      <Space size={6} wrap>
        <Button
          size="small"
          disabled={!props.editable || nothingSelected || props.busy}
          onClick={props.onApplyTypeToSelected}
        >
          Применить тип к выделенным ({props.selectedCount})
        </Button>
        <Popconfirm
          title={`Удалить выделенные блоки: ${String(props.selectedCount)}?`}
          okText="Удалить"
          cancelText="Отмена"
          onConfirm={props.onDeleteSelected}
          disabled={!props.editable || nothingSelected}
        >
          <Button size="small" danger disabled={!props.editable || nothingSelected || props.busy}>
            Удалить выделенные
          </Button>
        </Popconfirm>
        <Popconfirm
          title="Заменить страницу одним TEXT-блоком?"
          description="Прежние блоки страницы будут удалены."
          okText="Заменить"
          cancelText="Отмена"
          onConfirm={props.onReplacePage}
          disabled={!props.editable}
        >
          <Button size="small" disabled={!props.editable || props.busy}>
            Заменить страницу одним блоком
          </Button>
        </Popconfirm>
        <Button
          size="small"
          disabled={!props.editable || props.detecting}
          onClick={props.onRedetect}
        >
          Повторить детекцию страницы
        </Button>
        <Popconfirm
          title="Применить профиль full-page-text ко всему комплекту?"
          description="Операция удаляет прежние блоки страниц и недоступна после первой ручной правки."
          okText="Применить"
          cancelText="Отмена"
          onConfirm={props.onFullPageProfile}
          disabled={!props.editable || props.manuallyEdited}
        >
          <Button size="small" disabled={!props.editable || props.manuallyEdited || props.busy}>
            Профиль full-page-text
          </Button>
        </Popconfirm>
      </Space>

      <Select<number>
        size="small"
        value={props.zoom}
        onChange={props.onZoomChange}
        style={{ width: 100 }}
        aria-label="Масштаб"
        options={ZOOM_STEPS.map((step) => ({
          value: step,
          label: `${String(Math.round(step * 100))}%`,
        }))}
      />

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
