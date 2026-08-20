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
 * ## Заморозка и распознавание
 *
 * Две кнопки §6 разнесены: «Разметить файл» живёт на вкладке «Файлы» (там же,
 * где собирается рабочий документ), а здесь — заморозка разметки и отправка на
 * распознавание. `frozenLayoutId` передаётся явно (§14): «возьми текущую
 * замороженную» распознало бы не то, что видел пользователь.
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
import { catalogKeys, layoutKeys, revisionKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { LayoutBlock, PageClassification } from '../../api/types.js';
import { files as filesApi } from '../../api/endpoints.js';
import { useSession } from '../../app/session.js';
import { useQueryParam } from '../../app/router.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';
import { LAYOUT_STATE_LABELS } from '../../shared/labels.js';
import { BlockList } from './BlockList.js';
import { PageCanvas } from './PageCanvas.js';
import { PageTypePanel } from './PageTypePanel.js';
import { ThumbnailStrip, type PageTypeBadge } from './ThumbnailStrip.js';
import { VersionConflictModal } from './VersionConflictModal.js';
import { applyFilter, coverageOf, readingRanks, sortedForReading, BLOCK_STYLES } from './blocks.js';
import { framesAgree, fitInto } from './geometry.js';
import { closeDocuments } from './pdf/pdfjs.js';
import { usePdfPage } from './pdf/usePdfPage.js';
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

  const [selectedLayoutId, setSelectedLayoutId] = useState<string | null>(null);

  useEvidenceTarget();
  usePdfCacheCleanup();

  // Открывается последняя ревизия разметки. Явный выбор пользователя имеет
  // приоритет: инженер сравнивает замороженную с черновой, и «всегда последняя»
  // перебрасывало бы его обратно при каждом обновлении списка.
  const layoutId = selectedLayoutId ?? revisions.data?.[revisions.data.length - 1]?.id ?? null;

  if (revisions.isPending) return <LoadingState label="Загрузка ревизий разметки…" />;
  if (revisions.isError) return <ErrorState error={revisions.error} />;
  if (layoutId === null) {
    return (
      <Alert
        type="info"
        showIcon
        message="Разметки ещё нет"
        description={
          'Ревизия разметки создаётся кнопкой «Разметить файл» на вкладке «Файлы»: ' +
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
      layoutIds={(revisions.data ?? []).map((item) => ({
        id: item.id,
        label: `Ревизия ${String(item.revisionNo)} — ${LAYOUT_STATE_LABELS[item.state]}`,
      }))}
      onPickLayout={setSelectedLayoutId}
      canEdit={can('markup.edit')}
      canFreeze={can('markup.freeze')}
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
  readonly layoutIds: readonly { id: string; label: string }[];
  readonly onPickLayout: (layoutId: string) => void;
  readonly canEdit: boolean;
  readonly canFreeze: boolean;
  readonly canRecognize: boolean;
  /** Право `document.edit`: ручная метка типа страницы (§8.2), не связана с правкой блоков. */
  readonly canLabelPages: boolean;
  readonly onAfterRecognize: () => void;
  readonly notify: ReturnType<typeof AntApp.useApp>['message'];
}

function LayoutWorkspace(props: WorkspaceProps): ReactNode {
  const { revisionId, layoutId, canEdit, canFreeze, canRecognize, canLabelPages, notify } = props;

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

  const freeze = useMutation({
    mutationFn: () => layout.freeze(layoutId, editing.version),
    onSuccess: async (result) => {
      notify.success(`Разметка заморожена: блоков ${String(result.blockCount)}`);
      await detail.refetch();
      await blockList.refetch();
    },
    onError: (error) => notify.error(describeError(error)),
  });

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
  const frozen = layoutDetail.state !== 'draft';
  const editable = canEdit && !frozen;

  const pageList = pages.data ?? [];
  const currentPage =
    pageList.find((page) => page.workingPageIndex === store.workingPageIndex) ?? pageList[0];

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

  return (
    <>
      <MarkupToolbar
        state={layoutDetail.state}
        revisionNo={layoutDetail.revisionNo}
        blocksHash={layoutDetail.blocksHash}
        blockCount={blocks.length}
        coverage={coverageOf(pageBlocks)}
        layoutIds={props.layoutIds}
        layoutId={layoutId}
        onPickLayout={props.onPickLayout}
        editable={editable}
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
            onFilterChange={store.setFilter}
            onToggle={store.toggle}
            onSelectMany={store.selectMany}
          />
        </Col>
      </Row>

      <FreezeAndRecognize
        frozen={frozen}
        blockCount={blocks.length}
        canFreeze={canFreeze}
        canRecognize={canRecognize}
        freezing={freeze.isPending}
        recognizing={recognize.isPending}
        onFreeze={() => freeze.mutate()}
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

interface CanvasAreaProps {
  readonly page: {
    workingPageIndex: number;
    sourceFileId: string;
    filePageIndex: number;
    widthPx: number;
    heightPx: number;
    rotation: number;
  };
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
  const { page, zoom } = props;
  const holder = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState({ width: 800, height: 1000 });

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
    () => fitInto({ width: page.widthPx, height: page.heightPx }, available),
    [page.widthPx, page.heightPx, available],
  );
  const targetWidth = Math.max(80, Math.round(fitted.width * zoom));

  const rendered = usePdfPage({
    fileId: page.sourceFileId,
    contentUrl: filesApi.contentUrl(page.sourceFileId),
    filePageIndex: page.filePageIndex,
    targetWidth,
  });

  const size = rendered.page?.size ?? {
    width: targetWidth,
    height: (targetWidth * page.heightPx) / Math.max(1, page.widthPx),
  };

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
  readonly state: 'draft' | 'frozen' | 'superseded';
  readonly revisionNo: number;
  readonly blocksHash: string | null;
  readonly blockCount: number;
  readonly coverage: number;
  readonly layoutIds: readonly { id: string; label: string }[];
  readonly layoutId: string;
  readonly onPickLayout: (layoutId: string) => void;
  readonly editable: boolean;
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
      <Select
        size="small"
        value={props.layoutId}
        onChange={props.onPickLayout}
        options={props.layoutIds.map((item) => ({ value: item.id, label: item.label }))}
        style={{ minWidth: 220 }}
        aria-label="Ревизия разметки"
      />
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
    </div>
  );
}

// =====================================================================
// Нижняя панель: заморозка и отправка на распознавание (§6.2)
// =====================================================================

function FreezeAndRecognize(props: {
  readonly frozen: boolean;
  readonly blockCount: number;
  readonly canFreeze: boolean;
  readonly canRecognize: boolean;
  readonly freezing: boolean;
  readonly recognizing: boolean;
  readonly onFreeze: () => void;
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
        Распознавание идёт по замороженной разметке; провайдер и модель задаются в настройках
        портала.
      </Typography.Text>
      {!props.frozen ? (
        <Popconfirm
          title="Заморозить разметку?"
          description="После заморозки блоки этой ревизии не правятся; исправление — новая ревизия разметки."
          okText="Заморозить"
          cancelText="Отмена"
          onConfirm={props.onFreeze}
          disabled={!props.canFreeze || props.blockCount === 0}
        >
          <Button
            type="primary"
            data-testid="freeze-layout"
            loading={props.freezing}
            disabled={!props.canFreeze || props.blockCount === 0}
          >
            Заморозить разметку
          </Button>
        </Popconfirm>
      ) : (
        <Button
          type="primary"
          data-testid="send-to-recognition"
          loading={props.recognizing}
          disabled={!props.canRecognize}
          onClick={props.onRecognize}
        >
          Отправить на распознавание
        </Button>
      )}
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
 * Освобождение кэша документов pdf.js при уходе с экрана.
 *
 * Кэш держит открытый `PDFDocumentProxy` на каждый файл комплекта вместе с его
 * воркером и распакованными объектами. Без освобождения вкладка, в которой
 * инженер посмотрел десять поставок, удерживает страницы всех десяти: это
 * настоящая утечка, а не теоретическая — на сканах A3 счёт идёт на сотни
 * мегабайт.
 *
 * Содержимое файла неизменяемо (§3.3), поэтому повторное открытие того же файла
 * стоит только чтения xref заново — цена, которую платят один раз за возврат на
 * экран, а не постоянно за всё время жизни вкладки.
 */
function usePdfCacheCleanup(): void {
  useEffect(
    () => () => {
      void closeDocuments();
    },
    [],
  );
}
