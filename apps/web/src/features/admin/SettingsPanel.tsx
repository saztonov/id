/**
 * Настройки и интеграции (§10, §14).
 *
 * ## Секрет наружу не отдаётся даже частично
 *
 * Сервер присылает ссылку на место хранения и признак «задано», а не значение,
 * его префикс или длину: по префиксу токена определяется провайдер, по длине —
 * алгоритм. Экран это уважает и не пытается собрать значение обратно.
 *
 * ## `verified` берётся с сервера, а не печатается
 *
 * Наличие переменных окружения — это НЕ проверенное подключение. Сегодня сервер
 * возвращает `verified` литеральным `false` (`integrationStatusResponseSchema`),
 * и рисовать вместо этого зелёную галочку значило бы утверждать связь, которой
 * никто не проверял. Но и печатать «нет» текстом, не глядя в ответ, нельзя:
 * такая колонка перестанет быть правдой в тот день, когда появится живая проба,
 * и никто этого не заметит — утверждение о состоянии интеграции, не связанное с
 * её состоянием, хуже пустого места. Поэтому значение читается, а отсутствие
 * поля названо отдельно.
 *
 * Переключатель анализа через RD WEB заблокирован по своей причине:
 * generic-эндпоинта у них нет (§0.3, п. 6), и об этом сказано прямо, а не
 * спрятано.
 */
import { useState, type ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  detectionInferenceModeSettingSchema,
  detectionProviderSettingSchema,
  detectionSheetStrategySchema,
  largeSheetNumberZoneSchema,
  recognitionProviderSettingSchema,
  type DetectionInferenceModeSetting,
  type DetectionProviderSetting,
  type DetectionSheetStrategy,
  type LargeSheetNumberZone,
  type RecognitionProviderSetting,
} from '@id/contracts';
import { admin } from '../../api/endpoints.js';
import { adminKeys } from '../../api/keys.js';
import { describeError, isApiError } from '../../api/problem.js';
import type {
  AppSetting,
  IntegrationStatus,
  SecretReference,
  SettingControl,
  SettingsView,
} from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { mapFieldErrors } from '../../shared/formErrors.js';
import {
  DETECTION_SHEET_STRATEGY_LABELS,
  LARGE_SHEET_NUMBER_ZONE_LABELS,
} from '../../shared/labels.js';
import { ErrorState, LoadingState } from '../../shared/ui.js';

export function SettingsPanel(): ReactNode {
  const settings = useQuery({
    queryKey: adminKeys.settings(),
    queryFn: () => admin.settings(),
  });

  if (settings.isPending) return <LoadingState />;
  if (settings.isError) return <ErrorState error={settings.error} />;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <RecognitionSettingsCard view={settings.data} />
      <DetectionTuningCard view={settings.data} />

      <SettingsTables view={settings.data} />

      <Card size="small" title="Секреты">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Значения секретов не отдаются наружу ни целиком, ни частично: показывается место хранения
          и признак «задано».
        </Typography.Paragraph>
        <Table<SecretReference>
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={settings.data.secrets}
          locale={{ emptyText: 'Секретов не объявлено' }}
          columns={[
            { title: 'Ключ', dataIndex: 'key', key: 'key' },
            { title: 'Где хранится', dataIndex: 'reference', key: 'reference' },
            {
              title: 'Задан',
              dataIndex: 'configured',
              key: 'configured',
              render: (value: boolean) =>
                value ? <Tag color="green">да</Tag> : <Tag color="red">нет</Tag>,
            },
          ]}
        />
      </Card>

      <Card size="small" title="Интеграции">
        <Table<IntegrationStatus>
          rowKey="name"
          size="small"
          pagination={false}
          dataSource={settings.data.integrations}
          locale={{ emptyText: 'Интеграций не объявлено' }}
          columns={[
            { title: 'Интеграция', dataIndex: 'name', key: 'name' },
            {
              title: 'Конфигурация',
              dataIndex: 'status',
              key: 'status',
              render: (status: IntegrationStatus['status']) => (
                <Tag
                  color={
                    status === 'configured' ? 'blue' : status === 'disabled' ? 'default' : 'orange'
                  }
                >
                  {status === 'configured'
                    ? 'переменные заданы'
                    : status === 'disabled'
                      ? 'выключена'
                      : 'не хватает переменных'}
                </Tag>
              ),
            },
            {
              title: 'Не хватает',
              dataIndex: 'missing',
              key: 'missing',
              render: (missing: string[]) => (missing.length === 0 ? '—' : missing.join(', ')),
            },
            {
              title: 'Связь проверена',
              dataIndex: 'verified',
              key: 'verified',
              render: (verified: IntegrationStatus['verified'] | undefined) =>
                verified === undefined ? (
                  // Поле не пришло — значит либо сервер его больше не отдаёт,
                  // либо экран смотрит в другой маршрут. Собственная догадка на
                  // этом месте была бы утверждением о состоянии интеграции,
                  // которое никто не проверял.
                  <Tag color="orange">сервер не прислал признак</Tag>
                ) : verified ? (
                  <Tag color="green">да: подключение подтверждено пробой</Tag>
                ) : (
                  <Tag>нет: живой пробы подключения не выполнялось</Tag>
                ),
            },
          ]}
        />
      </Card>

      <Alert
        type="warning"
        showIcon
        message="Анализ через RD WEB недоступен"
        description={
          'Generic-эндпоинта структурного анализа текста у RD WEB нет — проверено чтением их ' +
          'исходников. Переключатель провайдера анализа присутствует в настройках и заблокирован ' +
          'до появления такого эндпоинта; требование внесено в техзадание на доработку.'
        }
      />
    </Space>
  );
}

// =====================================================================
// Распознавание и детекция (ADR-0007, ADR-0008)
// =====================================================================

/**
 * Клиентские зеркала серверных проверок значения
 * (`SETTINGS_REGISTRY` в `apps/api/src/modules/admin/schemas.ts`).
 *
 * Копия подписана источником: сервер остаётся единственным судьёй (422 с
 * pointer `/value`), а зеркало избавляет от заведомо отвергаемого запроса и
 * показывает ошибку до записи. Тексты сообщений — те же, что у сервера.
 */
const VLM_MODEL_PATTERN = /^$|^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.:-]*$/i;
const VLM_MODEL_MESSAGE = 'Слаг модели OpenRouter — «vendor/model», например qwen/qwen3-vl-235b';
const DETECTION_VERSION_PATTERN = /^$|^[a-z0-9][a-z0-9._-]*$/;
const DETECTION_VERSION_MESSAGE =
  'Версия модели — слаг из латиницы, цифр, точки, дефиса и подчёркивания';

/** Подписи провайдеров; значения — из enum'ов `@id/contracts`, не литералами. */
const RECOGNITION_PROVIDER_OPTION_LABELS: Record<RecognitionProviderSetting, string> = {
  rdweb: 'RD WEB (legacy)',
  openrouter_vlm: 'VLM через OpenRouter',
};
const DETECTION_PROVIDER_OPTION_LABELS: Record<DetectionProviderSetting, string> = {
  rdweb: 'RD WEB',
  local: 'Локально (RF-DETR, CPU)',
};

function settingString(view: SettingsView, key: string): string {
  const value = view.settings.find((item) => item.key === key)?.value;
  return typeof value === 'string' ? value : '';
}

/**
 * Карточка ветвления конвейера: провайдер распознавания и провайдер детекции.
 *
 * Настройки действуют только на НОВЫЕ прогоны — источник правды выполняющегося
 * прогона всегда его `settings_snapshot`, поэтому переключение здесь ничего не
 * останавливает и не перезапускает, и об этом сказано в подписи карточки.
 *
 * Селекты сохраняются сразу выбором: у enum-значения нет промежуточного
 * «черновика». Слаг модели и версия сохраняются кнопкой — строка набирается по
 * частям, и запись каждого нажатия клавиши сыпала бы 422 на полуслове.
 */
function RecognitionSettingsCard({ view }: { view: SettingsView }): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const canManage = can('settings.manage');

  const provider = recognitionProviderSettingSchema.safeParse(
    settingString(view, 'recognition.provider'),
  );
  const recognitionProvider: RecognitionProviderSetting = provider.success
    ? provider.data
    : 'rdweb';
  const detection = detectionProviderSettingSchema.safeParse(
    settingString(view, 'detection.provider'),
  );
  const detectionProvider: DetectionProviderSetting = detection.success ? detection.data : 'rdweb';

  const strategy = detectionSheetStrategySchema.safeParse(
    settingString(view, 'detection.sheet_strategy'),
  );
  const sheetStrategy: DetectionSheetStrategy = strategy.success ? strategy.data : 'detect_all';
  const zone = largeSheetNumberZoneSchema.safeParse(
    settingString(view, 'detection.large_sheet_number_zone'),
  );
  const numberZone: LargeSheetNumberZone = zone.success ? zone.data : 'near_stamp';

  const [modelDraft, setModelDraft] = useState(() => settingString(view, 'recognition.vlm_model'));
  const [versionDraft, setVersionDraft] = useState(() =>
    settingString(view, 'detection.model_version'),
  );
  /** Ошибка у поля по ключу настройки: клиентская или 422 сервера. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: (input: { key: string; value: unknown }) =>
      admin.setSetting(input.key, input.value),
    onSuccess: async (saved) => {
      setFieldErrors((prev) => ({ ...prev, [saved.key]: '' }));
      message.success(`Настройка «${saved.title}» сохранена`);
      await queryClient.invalidateQueries({ queryKey: adminKeys.settings() });
    },
    onError: (error, input) => {
      // 422 несёт pointer `/value` — полю формы он не соответствует, поэтому
      // сообщения берутся из mapFieldErrors как unmatched и встают к тому полю,
      // которое сохранялось. 404 и 409 — не про значение, а про ключ: уведомление.
      const mapped = mapFieldErrors(error, []);
      if (isApiError(error) && error.status === 422 && mapped.unmatched.length > 0) {
        setFieldErrors((prev) => ({ ...prev, [input.key]: mapped.unmatched.join('; ') }));
        return;
      }
      message.error(describeError(error));
    },
  });

  const saveValidated = (
    key: string,
    value: string,
    pattern: RegExp,
    failMessage: string,
  ): void => {
    if (!pattern.test(value)) {
      setFieldErrors((prev) => ({ ...prev, [key]: failMessage }));
      return;
    }
    setFieldErrors((prev) => ({ ...prev, [key]: '' }));
    save.mutate({ key, value });
  };

  const proxyLlm = view.integrations.find((item) => item.name === 'proxy_llm');
  const savedModel = settingString(view, 'recognition.vlm_model');
  const savedVersion = settingString(view, 'detection.model_version');

  const fieldError = (key: string): ReactNode =>
    (fieldErrors[key] ?? '') === '' ? null : (
      <Typography.Text type="danger" data-testid={`setting-error-${key}`}>
        {fieldErrors[key]}
      </Typography.Text>
    );

  return (
    <Card size="small" title="Распознавание и детекция" data-testid="recognition-settings">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Настройки действуют только на новые прогоны: выполняющийся прогон читает собственный снимок
        настроек и переключением не затрагивается.
      </Typography.Paragraph>

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap align="start" size={16}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Провайдер распознавания</span>
            <Select<RecognitionProviderSetting>
              style={{ width: 260 }}
              value={recognitionProvider}
              options={recognitionProviderSettingSchema.options.map((value) => ({
                value,
                label: RECOGNITION_PROVIDER_OPTION_LABELS[value],
              }))}
              disabled={!canManage || save.isPending}
              onChange={(value) => save.mutate({ key: 'recognition.provider', value })}
              aria-label="Провайдер распознавания"
              data-testid="recognition-provider-select"
            />
          </div>

          {recognitionProvider === 'openrouter_vlm' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 460 }}>
              <span>Модель OpenRouter (слаг)</span>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  placeholder="vendor/model"
                  disabled={!canManage}
                  aria-label="Модель OpenRouter (слаг)"
                  data-testid="recognition-model-input"
                />
                <Button
                  loading={save.isPending}
                  disabled={!canManage}
                  onClick={() =>
                    saveValidated(
                      'recognition.vlm_model',
                      modelDraft.trim(),
                      VLM_MODEL_PATTERN,
                      VLM_MODEL_MESSAGE,
                    )
                  }
                  data-testid="recognition-model-save"
                >
                  Сохранить
                </Button>
              </Space.Compact>
              {fieldError('recognition.vlm_model')}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Существование модели не проверяется при сохранении — ошибка провайдера проявится в
                прогоне распознавания (История → Прогоны) и в консоли задач.
              </Typography.Text>
            </div>
          )}
        </Space>

        {recognitionProvider === 'openrouter_vlm' && savedModel === '' && (
          <Alert
            type="warning"
            showIcon
            data-testid="vlm-model-missing"
            message="Модель не выбрана"
            description="Слаг модели пуст: прогон с провайдером VLM откажет при старте (409), пока модель не задана."
          />
        )}

        {recognitionProvider === 'openrouter_vlm' &&
          (proxyLlm === undefined || proxyLlm.status !== 'configured') && (
            <Alert
              type="warning"
              showIcon
              data-testid="proxy-llm-warning"
              message="Шлюз proxy_llm не сконфигурирован"
              description={
                proxyLlm === undefined
                  ? 'Сервер не объявил интеграцию proxy_llm — распознаванию через OpenRouter не через что ходить.'
                  : proxyLlm.status === 'disabled'
                    ? 'Провайдер LLM в окружении — не proxy_llm (переменная LLM_PROVIDER): распознавание через OpenRouter ходит только через этот шлюз, и прогоны VLM будут отказывать.'
                    : `Распознавание через OpenRouter ходит через шлюз proxy_llm, а окружению не хватает переменных${
                        proxyLlm.missing.length > 0 ? `: ${proxyLlm.missing.join(', ')}` : ''
                      }. Прогоны VLM будут отказывать до настройки окружения.`
              }
            />
          )}

        <Space wrap align="start" size={16}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Провайдер детекции блоков</span>
            <Select<DetectionProviderSetting>
              style={{ width: 260 }}
              value={detectionProvider}
              options={detectionProviderSettingSchema.options.map((value) => ({
                value,
                label: DETECTION_PROVIDER_OPTION_LABELS[value],
              }))}
              disabled={!canManage || save.isPending}
              onChange={(value) => save.mutate({ key: 'detection.provider', value })}
              aria-label="Провайдер детекции блоков"
              data-testid="detection-provider-select"
            />
          </div>

          {detectionProvider === 'local' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Правило разметки по формату листа</span>
              <Select<DetectionSheetStrategy>
                style={{ width: 320 }}
                value={sheetStrategy}
                options={detectionSheetStrategySchema.options.map((value) => ({
                  value,
                  label: DETECTION_SHEET_STRATEGY_LABELS[value],
                }))}
                disabled={!canManage || save.isPending}
                onChange={(value) => save.mutate({ key: 'detection.sheet_strategy', value })}
                aria-label="Правило разметки по формату листа"
                data-testid="detection-sheet-strategy-select"
              />
              {/*
                Правило запинывается на ревизии при создании черновика, и
                эксплуатации это надо сказать прямо: без явной передетекции уже
                размеченный комплект переключение не увидит, и настройка будет
                выглядеть неработающей.
              */}
              <span style={{ fontSize: 12, color: '#8c8c8c', maxWidth: 320 }}>
                Действует на новые разметки. Чтобы применить к уже размеченному комплекту, нужна
                повторная детекция.
              </span>
            </div>
          )}

          {detectionProvider === 'local' && sheetStrategy === 'sheet_aware' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span>Номер листа на крупном формате</span>
              <Select<LargeSheetNumberZone>
                style={{ width: 320 }}
                value={numberZone}
                options={largeSheetNumberZoneSchema.options.map((value) => ({
                  value,
                  label: LARGE_SHEET_NUMBER_ZONE_LABELS[value],
                }))}
                disabled={!canManage || save.isPending}
                onChange={(value) =>
                  save.mutate({ key: 'detection.large_sheet_number_zone', value })
                }
                aria-label="Номер листа на крупном формате"
                data-testid="detection-number-zone-select"
              />
              <span style={{ fontSize: 12, color: '#8c8c8c', maxWidth: 320 }}>
                В штампе чертежа стоит обозначение проекта, общее у всех листов раздела. Собственный
                номер листа напечатан отдельной ячейкой рядом — без него схема не находит свою
                строку в реестре приложений.
              </span>
            </div>
          )}

          {detectionProvider === 'local' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 460 }}>
              <span>Версия модели детекции</span>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={versionDraft}
                  onChange={(event) => setVersionDraft(event.target.value)}
                  disabled={!canManage}
                  aria-label="Версия модели детекции"
                  data-testid="detection-model-version-input"
                />
                <Button
                  loading={save.isPending}
                  disabled={!canManage}
                  onClick={() =>
                    saveValidated(
                      'detection.model_version',
                      versionDraft.trim(),
                      DETECTION_VERSION_PATTERN,
                      DETECTION_VERSION_MESSAGE,
                    )
                  }
                  data-testid="detection-model-version-save"
                >
                  Сохранить
                </Button>
              </Space.Compact>
              {fieldError('detection.model_version')}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Префикс ключа весов в хранилище (models/detection/{'{'}версия{'}'}).
              </Typography.Text>
            </div>
          )}
        </Space>

        {detectionProvider === 'local' && savedVersion === '' && (
          <Alert
            type="warning"
            showIcon
            data-testid="detection-model-missing"
            message="Модель детекции не загружена"
            description="Версия локальной модели пуста — модель не загружена: задачи локальной детекции будут честно отказывать. Ручная разметка работает всегда."
          />
        )}
      </Space>
    </Card>
  );
}

// =====================================================================
// Качество детекции блоков (ADR-0008)
// =====================================================================

/** Подписи режимов инференса; значения — из перечисления `@id/contracts`. */
const INFERENCE_MODE_LABELS: Record<DetectionInferenceModeSetting, string> = {
  auto: 'Авто (по манифесту модели)',
  tiles: 'Плитками (принудительно)',
  whole_page: 'Страница целиком (принудительно)',
};

/** Тип блока в порогах по классам. Порядок — как в `class_mapping` модели. */
const TUNING_BLOCK_TYPES = ['text', 'image', 'stamp'] as const;
type TuningBlockType = (typeof TUNING_BLOCK_TYPES)[number];

const TUNING_BLOCK_TYPE_LABELS: Record<TuningBlockType, string> = {
  text: 'Текст',
  image: 'Изображение',
  stamp: 'Штамп',
};

function settingRaw(view: SettingsView, key: string): unknown {
  return view.settings.find((item) => item.key === key)?.value;
}

/** Хранимое число либо `null` («из манифеста»). */
function settingNumber(view: SettingsView, key: string): number | null {
  const value = settingRaw(view, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Карточка ручек качества детекции.
 *
 * ## Почему это вообще настройки, а не константы
 *
 * В эталонном RD WEB порог принятия, NMS IoU, склейка разорванного текста,
 * потолок детекций и режим инференса — настройки сервиса. У портала их не было:
 * всё читалось только из манифеста модели, а манифест их не обязан содержать и
 * на практике не содержит. Действовали хардкод-дефолты, и «страница не
 * обведена» оказывалось состоянием без выхода — снизить порог можно было
 * только правкой файла модели в хранилище.
 *
 * ## Пусто — это «из манифеста», а не ноль
 *
 * Пустое поле означает, что значение берётся из манифеста модели. Иначе
 * администратор, впервые открывший карточку и ничего не менявший, навязал бы
 * модели значения по умолчанию — а манифест перестал бы быть источником
 * параметров модели. По той же причине у склейки текста три состояния, а не
 * переключатель: «выключить» и «не трогать» — разные решения.
 *
 * ## Числа сохраняются кнопкой, перечисления — выбором
 *
 * У числа есть промежуточные состояния набора (`0.`, `0.2`), и запись каждого
 * нажатия клавиши сыпала бы 422 на полуслове. У перечисления промежуточного
 * состояния нет — тот же выбор, что и в карточке выше.
 */
function DetectionTuningCard({ view }: { view: SettingsView }): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const canManage = can('settings.manage');

  const detection = detectionProviderSettingSchema.safeParse(
    settingString(view, 'detection.provider'),
  );
  const provider: DetectionProviderSetting = detection.success ? detection.data : 'rdweb';

  const mode = detectionInferenceModeSettingSchema.safeParse(
    settingString(view, 'detection.inference_mode'),
  );
  const inferenceMode: DetectionInferenceModeSetting = mode.success ? mode.data : 'auto';

  const mergeRaw = settingRaw(view, 'detection.merge_split_text');
  const mergeSplitText: 'manifest' | 'on' | 'off' =
    typeof mergeRaw === 'boolean' ? (mergeRaw ? 'on' : 'off') : 'manifest';

  const perClassRaw = settingRaw(view, 'detection.per_class_thresholds');
  const perClassStored: Partial<Record<TuningBlockType, number>> =
    typeof perClassRaw === 'object' && perClassRaw !== null && !Array.isArray(perClassRaw)
      ? (perClassRaw as Partial<Record<TuningBlockType, number>>)
      : {};

  const [threshold, setThreshold] = useState<number | null>(() =>
    settingNumber(view, 'detection.score_threshold'),
  );
  const [nmsIou, setNmsIou] = useState<number | null>(() =>
    settingNumber(view, 'detection.nms_iou'),
  );
  const [maxDetections, setMaxDetections] = useState<number | null>(() =>
    settingNumber(view, 'detection.max_detections'),
  );
  const [perClass, setPerClass] =
    useState<Partial<Record<TuningBlockType, number | null>>>(perClassStored);

  const save = useMutation({
    mutationFn: (input: { key: string; value: unknown }) =>
      admin.setSetting(input.key, input.value),
    onSuccess: async (saved) => {
      message.success(`Настройка «${saved.title}» сохранена`);
      await queryClient.invalidateQueries({ queryKey: adminKeys.settings() });
    },
    onError: (error) => {
      message.error(describeError(error));
    },
  });

  // Карточка относится только к локальной детекции: у ветки RD WEB
  // постобработка живёт на их стороне, и показывать ручки, которые ни на что не
  // влияют, — то же самое, что врать.
  if (provider !== 'local') return null;

  const disabled = !canManage || save.isPending;

  return (
    <Card size="small" title="Качество детекции блоков" data-testid="detection-tuning">
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        Пустое поле — значение берётся из манифеста модели. Настройки действуют на новые задачи
        детекции; чтобы применить их к уже размеченным страницам, нажмите «Повторить детекцию
        страницы» на экране разметки. Применённые переопределения попадают в журнал задачи.
      </Typography.Paragraph>

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap align="start" size={16}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 }}>
            <span>Режим инференса</span>
            <Select<DetectionInferenceModeSetting>
              style={{ width: 280 }}
              value={inferenceMode}
              options={detectionInferenceModeSettingSchema.options.map((value) => ({
                value,
                label: INFERENCE_MODE_LABELS[value],
              }))}
              disabled={disabled}
              onChange={(value) => {
                save.mutate({ key: 'detection.inference_mode', value });
              }}
              aria-label="Режим инференса детектора"
              data-testid="detection-inference-mode"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Инференс обязан идти в масштабе кадра обучения: модель, обученная на целых страницах,
              на плитках выдаёт боксы ~на весь кадр.
            </Typography.Text>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 }}>
            <span>Склейка разорванного текста</span>
            <Select<'manifest' | 'on' | 'off'>
              style={{ width: 220 }}
              value={mergeSplitText}
              options={[
                { value: 'manifest', label: 'Из манифеста' },
                { value: 'on', label: 'Склеивать' },
                { value: 'off', label: 'Не склеивать' },
              ]}
              disabled={disabled}
              onChange={(value) => {
                save.mutate({
                  key: 'detection.merge_split_text',
                  value: value === 'manifest' ? null : value === 'on',
                });
              }}
              aria-label="Склейка разорванного текста"
              data-testid="detection-merge-split-text"
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Объединяет соседние текстовые блоки. Штампы и изображения не склеиваются никогда.
            </Typography.Text>
          </div>
        </Space>

        <Space wrap align="start" size={16}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 }}>
            <span>Порог принятия детекции</span>
            <Space.Compact>
              <InputNumber
                style={{ width: 140 }}
                min={0}
                max={1}
                step={0.05}
                value={threshold}
                onChange={setThreshold}
                placeholder="из манифеста"
                disabled={!canManage}
                aria-label="Порог принятия детекции"
                data-testid="detection-score-threshold"
              />
              <Button
                loading={save.isPending}
                disabled={!canManage}
                onClick={() => {
                  save.mutate({ key: 'detection.score_threshold', value: threshold });
                }}
                data-testid="detection-score-threshold-save"
              >
                Сохранить
              </Button>
            </Space.Compact>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Ниже порога детекция отбрасывается. Снижают, когда страницы остаются без блоков.
            </Typography.Text>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 }}>
            <span>Порог IoU при подавлении пересечений</span>
            <Space.Compact>
              <InputNumber
                style={{ width: 140 }}
                min={0}
                max={1}
                step={0.05}
                value={nmsIou}
                onChange={setNmsIou}
                placeholder="из манифеста"
                disabled={!canManage}
                aria-label="Порог IoU при подавлении пересечений"
                data-testid="detection-nms-iou"
              />
              <Button
                loading={save.isPending}
                disabled={!canManage}
                onClick={() => {
                  save.mutate({ key: 'detection.nms_iou', value: nmsIou });
                }}
                data-testid="detection-nms-iou-save"
              >
                Сохранить
              </Button>
            </Space.Compact>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Блоки разных типов друг друга не подавляют.
            </Typography.Text>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 320 }}>
            <span>Потолок детекций на страницу</span>
            <Space.Compact>
              <InputNumber
                style={{ width: 140 }}
                min={1}
                max={10000}
                step={1}
                precision={0}
                value={maxDetections}
                onChange={setMaxDetections}
                placeholder="из манифеста"
                disabled={!canManage}
                aria-label="Потолок детекций на страницу"
                data-testid="detection-max-detections"
              />
              <Button
                loading={save.isPending}
                disabled={!canManage}
                onClick={() => {
                  save.mutate({ key: 'detection.max_detections', value: maxDetections });
                }}
                data-testid="detection-max-detections-save"
              >
                Сохранить
              </Button>
            </Space.Compact>
          </div>
        </Space>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Пороги принятия по типам блоков</span>
          <Space wrap align="center" size={8}>
            {TUNING_BLOCK_TYPES.map((type) => (
              <InputNumber
                key={type}
                style={{ width: 200 }}
                min={0}
                max={1}
                step={0.05}
                value={perClass[type] ?? null}
                onChange={(value) => {
                  setPerClass((previous) => ({ ...previous, [type]: value }));
                }}
                placeholder="из манифеста"
                addonBefore={TUNING_BLOCK_TYPE_LABELS[type]}
                disabled={!canManage}
                aria-label={`Порог принятия: ${TUNING_BLOCK_TYPE_LABELS[type]}`}
                data-testid={`detection-threshold-${type}`}
              />
            ))}
            <Button
              loading={save.isPending}
              disabled={!canManage}
              onClick={() => {
                // Пустое поле означает «нет переопределения», поэтому ключ не
                // пишется вовсе: записанный ноль означал бы «принимать всё»,
                // а это другое решение.
                const value: Record<string, number> = {};
                for (const type of TUNING_BLOCK_TYPES) {
                  const perType = perClass[type];
                  if (typeof perType === 'number') value[type] = perType;
                }
                save.mutate({ key: 'detection.per_class_thresholds', value });
              }}
              data-testid="detection-per-class-save"
            >
              Сохранить
            </Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Перекрывают общий порог для своего типа. Незаполненный тип берёт общий порог.
          </Typography.Text>
        </div>
      </Space>
    </Card>
  );
}

// =====================================================================
// Таблицы настроек: правка по дескриптору контрола
// =====================================================================

/**
 * Группы ключей.
 *
 * Список ключей не полон намеренно: ключ, не попавший ни в одну группу,
 * показывается в «Прочих», а не исчезает с экрана. Реестр живёт на сервере, и
 * экран, который печатает только известные ему ключи, скрыл бы новую настройку
 * ровно в тот день, когда её завели.
 */
const OPERATIONAL_KEYS: readonly string[] = [
  'recognition.provider',
  'recognition.vlm_model',
  'analysis.model',
  'orientation.probe_enabled',
  'orientation.probe_model',
  'detection.provider',
  'detection.model_version',
];

const EXPERT_KEYS: readonly string[] = [
  'detection.sheet_strategy',
  'detection.large_sheet_number_zone',
  'detection.inference_mode',
  'detection.score_threshold',
  'detection.per_class_thresholds',
  'detection.nms_iou',
  'detection.merge_split_text',
  'detection.max_detections',
];

const MODE_KEYS: readonly string[] = ['core.enforce_immutability', 'ai.dry_run_only'];

/**
 * Ключи, редактор которых живёт в карточке выше, и название этой карточки.
 *
 * Второй редактор того же ключа в таблице сделал бы экран двусмысленным: два
 * контрола, показывающих одно значение, расходятся на глазах у человека при
 * первой же неудачной записи. Поэтому в таблице такие ключи только читаются, а
 * строка называет место, где их правят, — иначе поиск по таблице приводит в
 * тупик, что и произошло с правилом разметки по формату листа.
 */
const CARD_MANAGED_KEYS: Readonly<Record<string, string>> = {
  'recognition.provider': 'Распознавание и детекция',
  'recognition.vlm_model': 'Распознавание и детекция',
  'detection.provider': 'Распознавание и детекция',
  'detection.model_version': 'Распознавание и детекция',
  'detection.sheet_strategy': 'Распознавание и детекция',
  'detection.large_sheet_number_zone': 'Распознавание и детекция',
  'detection.inference_mode': 'Качество детекции блоков',
  'detection.score_threshold': 'Качество детекции блоков',
  'detection.per_class_thresholds': 'Качество детекции блоков',
  'detection.nms_iou': 'Качество детекции блоков',
  'detection.merge_split_text': 'Качество детекции блоков',
  'detection.max_detections': 'Качество детекции блоков',
};

/**
 * Подписи значений перечислений — по ключу настройки, а не общей картой.
 *
 * У провайдера распознавания и провайдера детекции одно и то же значение
 * `rdweb`, а названия разные: слитая карта показала бы одному из них чужое.
 * Ключ без подписей печатает значения как есть — это честнее выдуманного
 * названия и не мешает новой настройке появиться на экране.
 */
const ENUM_LABELS_BY_KEY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'recognition.provider': RECOGNITION_PROVIDER_OPTION_LABELS,
  'detection.provider': DETECTION_PROVIDER_OPTION_LABELS,
  'detection.sheet_strategy': DETECTION_SHEET_STRATEGY_LABELS,
  'detection.large_sheet_number_zone': LARGE_SHEET_NUMBER_ZONE_LABELS,
  'detection.inference_mode': INFERENCE_MODE_LABELS,
};

function SettingsTables({ view }: { view: SettingsView }): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const canManage = can('settings.manage');

  /** Ошибка записи по ключу: 422 сервера ложится к своей строке. */
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Ключ, по которому сейчас идёт запись: остальные строки не блокируются. */
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: adminKeys.settings() });
  };

  const save = useMutation({
    mutationFn: (input: { key: string; value: unknown }) =>
      admin.setSetting(input.key, input.value),
    onMutate: (input) => {
      setPendingKey(input.key);
    },
    onSuccess: async (saved) => {
      setFieldErrors((prev) => ({ ...prev, [saved.key]: '' }));
      message.success(`Настройка «${saved.title}» сохранена`);
      await invalidate();
    },
    onError: (error, input) => {
      // 422 несёт pointer `/value`, полю формы он не соответствует: сообщения
      // приходят как unmatched и встают к строке, которая сохранялась.
      const mapped = mapFieldErrors(error, []);
      if (isApiError(error) && error.status === 422 && mapped.unmatched.length > 0) {
        setFieldErrors((prev) => ({ ...prev, [input.key]: mapped.unmatched.join('; ') }));
        return;
      }
      message.error(describeError(error));
    },
    onSettled: () => {
      setPendingKey(null);
    },
  });

  const reset = useMutation({
    mutationFn: (key: string) => admin.resetSetting(key),
    onMutate: (key) => {
      setPendingKey(key);
    },
    onSuccess: async (restored) => {
      setFieldErrors((prev) => ({ ...prev, [restored.key]: '' }));
      message.success(`Настройка «${restored.title}» вернулась к значению по умолчанию`);
      await invalidate();
    },
    onError: (error) => {
      message.error(describeError(error));
    },
    onSettled: () => {
      setPendingKey(null);
    },
  });

  const columns = [
    { title: 'Ключ', dataIndex: 'key', key: 'key', width: 260 },
    { title: 'Назначение', dataIndex: 'title', key: 'title' },
    {
      title: 'Значение',
      key: 'value',
      width: 320,
      render: (_: unknown, setting: AppSetting) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <SettingValue
            // Черновик строки живёт в её собственном состоянии, и после записи
            // строка обязана перечитать значение с сервера: ключ включает
            // значение, поэтому редактор пересоздаётся вместе с ним.
            key={`${setting.key}:${JSON.stringify(setting.value)}`}
            setting={setting}
            disabled={!canManage || pendingKey === setting.key}
            onSave={(value) => {
              save.mutate({ key: setting.key, value });
            }}
          />
          {(fieldErrors[setting.key] ?? '') === '' ? null : (
            <Typography.Text type="danger" data-testid={`setting-error-${setting.key}`}>
              {fieldErrors[setting.key]}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Источник',
      dataIndex: 'isDefault',
      key: 'isDefault',
      width: 190,
      render: (isDefault: boolean) =>
        isDefault ? <Tag>значение по умолчанию</Tag> : <Tag color="blue">задано</Tag>,
    },
    {
      title: 'Изменено',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 200,
      render: (value: string | null) => value ?? '—',
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_: unknown, setting: AppSetting) =>
        setting.isDefault || setting.managedBy !== null ? null : (
          <Popconfirm
            title="Вернуть значение по умолчанию?"
            description="Строка настройки удалится, и значение снова будет браться из кода портала."
            okText="Сбросить"
            cancelText="Отмена"
            onConfirm={() => {
              reset.mutate(setting.key);
            }}
          >
            <Button
              size="small"
              disabled={!canManage || pendingKey === setting.key}
              data-testid={`setting-reset-${setting.key}`}
            >
              Сбросить
            </Button>
          </Popconfirm>
        ),
    },
  ];

  const known = new Set([...OPERATIONAL_KEYS, ...EXPERT_KEYS, ...MODE_KEYS]);
  const groups: { title: string; caption: string; rows: AppSetting[] }[] = [
    {
      title: 'Рабочие настройки',
      caption:
        'Провайдеры, модели и версия весов. Действуют на новые прогоны: выполняющийся прогон читает собственный снимок настроек.',
      rows: view.settings.filter((setting) => OPERATIONAL_KEYS.includes(setting.key)),
    },
    {
      title: 'Экспертные настройки (подбираются замером)',
      caption:
        'Пороги и режимы детекции. Значения выводятся замером на стенде, а не подбираются наугад: пустое поле означает «взять из манифеста модели».',
      rows: view.settings.filter((setting) => EXPERT_KEYS.includes(setting.key)),
    },
    {
      title: 'Режимы тестирования',
      caption:
        'Снимают инварианты портала ради прогона сценария целиком. В рабочем режиме неизменяемость включена, а dry-run выключен; любое переключение попадает в журнал аудита.',
      rows: view.settings.filter((setting) => MODE_KEYS.includes(setting.key)),
    },
    {
      title: 'Прочие настройки',
      caption:
        'Ключи, у которых есть собственный маршрут управления либо которые ещё не отнесены ни к одной группе.',
      rows: view.settings.filter((setting) => !known.has(setting.key)),
    },
  ];

  return (
    <>
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <Card key={group.title} size="small" title={group.title}>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              {group.caption}
            </Typography.Paragraph>
            <Table<AppSetting>
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={group.rows}
              locale={{ emptyText: 'Настроек нет' }}
              columns={columns}
            />
          </Card>
        ))}
    </>
  );
}

/**
 * Контрол одной строки — по дескриптору, пришедшему с сервера.
 *
 * Перечисления и переключатели сохраняются сразу выбором: промежуточного
 * состояния у них нет. Строки и числа набираются по частям, поэтому у них
 * кнопка — запись каждого нажатия клавиши сыпала бы 422 на полуслове.
 */
function SettingValue({
  setting,
  disabled,
  onSave,
}: {
  setting: AppSetting;
  disabled: boolean;
  onSave: (value: unknown) => void;
}): ReactNode {
  const cardTitle = CARD_MANAGED_KEYS[setting.key];

  if (setting.managedBy !== null) {
    return (
      <Space direction="vertical" size={2}>
        <Typography.Text code>{JSON.stringify(setting.value)}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Меняется маршрутом {setting.managedBy}
        </Typography.Text>
      </Space>
    );
  }

  if (cardTitle !== undefined) {
    return (
      <Space direction="vertical" size={2}>
        <Typography.Text code>{JSON.stringify(setting.value)}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Правится в карточке «{cardTitle}» выше
        </Typography.Text>
      </Space>
    );
  }

  return <SettingControlEditor setting={setting} disabled={disabled} onSave={onSave} />;
}

function SettingControlEditor({
  setting,
  disabled,
  onSave,
}: {
  setting: AppSetting;
  disabled: boolean;
  onSave: (value: unknown) => void;
}): ReactNode {
  const control: SettingControl = setting.control;
  const testId = `setting-value-${setting.key}`;

  if (control.kind === 'boolean' && control.nullable !== true) {
    return (
      <Switch
        checked={setting.value === true}
        disabled={disabled}
        onChange={onSave}
        aria-label={setting.title}
        data-testid={testId}
      />
    );
  }

  if (control.kind === 'boolean') {
    // Третье состояние — «значение берётся из манифеста модели», и оно не то же
    // самое, что «не склеивать»: выключить и не трогать — разные решения.
    const value = setting.value === null ? 'manifest' : setting.value === true ? 'on' : 'off';
    return (
      <Select<'manifest' | 'on' | 'off'>
        style={{ width: 200 }}
        value={value}
        options={[
          { value: 'manifest', label: 'Из манифеста' },
          { value: 'on', label: 'Да' },
          { value: 'off', label: 'Нет' },
        ]}
        disabled={disabled}
        onChange={(next) => {
          onSave(next === 'manifest' ? null : next === 'on');
        }}
        aria-label={setting.title}
        data-testid={testId}
      />
    );
  }

  if (control.kind === 'enum') {
    return (
      <Select<string>
        style={{ width: 280 }}
        value={typeof setting.value === 'string' ? setting.value : null}
        options={control.options.map((option) => ({
          value: option,
          label: (ENUM_LABELS_BY_KEY[setting.key] ?? {})[option] ?? option,
        }))}
        disabled={disabled}
        onChange={onSave}
        aria-label={setting.title}
        data-testid={testId}
      />
    );
  }

  if (control.kind === 'number') {
    return (
      <NumberSetting
        setting={setting}
        control={control}
        disabled={disabled}
        onSave={onSave}
        testId={testId}
      />
    );
  }

  if (control.kind === 'string') {
    return (
      <StringSetting
        setting={setting}
        control={control}
        disabled={disabled}
        onSave={onSave}
        testId={testId}
      />
    );
  }

  // Составное значение правится там, где у него есть смысл по частям: общий
  // редактор показал бы JSON, в котором опечатка стоит дороже удобства.
  return <Typography.Text code>{JSON.stringify(setting.value)}</Typography.Text>;
}

function NumberSetting({
  setting,
  control,
  disabled,
  onSave,
  testId,
}: {
  setting: AppSetting;
  control: Extract<SettingControl, { kind: 'number' }>;
  disabled: boolean;
  onSave: (value: unknown) => void;
  testId: string;
}): ReactNode {
  const [draft, setDraft] = useState<number | null>(() =>
    typeof setting.value === 'number' ? setting.value : null,
  );

  return (
    <Space.Compact>
      <InputNumber
        style={{ width: 160 }}
        {...(control.min === undefined ? {} : { min: control.min })}
        {...(control.max === undefined ? {} : { max: control.max })}
        {...(control.step === undefined ? {} : { step: control.step })}
        {...(control.integer === true ? { precision: 0 } : {})}
        value={draft}
        onChange={(value) => {
          setDraft(typeof value === 'number' ? value : null);
        }}
        {...(control.nullable === true ? { placeholder: 'из манифеста' } : {})}
        disabled={disabled}
        aria-label={setting.title}
        data-testid={testId}
      />
      <Button
        disabled={disabled}
        onClick={() => {
          onSave(draft);
        }}
        data-testid={`${testId}-save`}
      >
        Сохранить
      </Button>
    </Space.Compact>
  );
}

function StringSetting({
  setting,
  control,
  disabled,
  onSave,
  testId,
}: {
  setting: AppSetting;
  control: Extract<SettingControl, { kind: 'string' }>;
  disabled: boolean;
  onSave: (value: unknown) => void;
  testId: string;
}): ReactNode {
  const [draft, setDraft] = useState<string>(() =>
    typeof setting.value === 'string' ? setting.value : '',
  );

  return (
    <Space.Compact style={{ width: '100%' }}>
      {control.multiline === true ? (
        <Input.TextArea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          {...(control.placeholder === undefined ? {} : { placeholder: control.placeholder })}
          disabled={disabled}
          aria-label={setting.title}
          data-testid={testId}
          autoSize={{ minRows: 1, maxRows: 4 }}
        />
      ) : (
        <Input
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          {...(control.placeholder === undefined ? {} : { placeholder: control.placeholder })}
          disabled={disabled}
          aria-label={setting.title}
          data-testid={testId}
        />
      )}
      <Button
        disabled={disabled}
        onClick={() => {
          onSave(draft.trim());
        }}
        data-testid={`${testId}-save`}
      >
        Сохранить
      </Button>
    </Space.Compact>
  );
}
