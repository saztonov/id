/**
 * Профили видов разделов (§9.1, §14).
 *
 * ## Зачем экран нужен, а не просто «ещё одна таблица справочника»
 *
 * Профиль — это то, чем правила полноты отличают «комплект неполон» от «раздел
 * не настроен». Ожидаемый состав документов, матрица материалов, включённые
 * правила и уровень автономии живут здесь и только здесь; без экрана они
 * правились бы прямым INSERT, а прогон проверок ссылался бы на то, чего никто
 * не видел.
 *
 * ## «Профиля нет» — законное состояние, а не пустая таблица
 *
 * Маршрут действующего профиля отвечает 404, когда на дату профиля нет. Это
 * ответ, а не отказ: §9.1 прямо требует различать его от «профиль есть, и
 * комплект ему не соответствует». Поэтому 404 показывается объяснением, а не
 * `ErrorState` и не пустой строкой.
 *
 * ## Уровень автономии виден и объяснён
 *
 * `automatic` сервер не даёт поставить, пока накопленная статистика раздела его
 * не подтвердит (§0.5, п. 5). Экран не прячет отказ за выключенной кнопкой:
 * значение доступно в форме, а причина отказа приходит от сервера и
 * показывается целиком.
 */
import { useState, type ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MATERIAL_CATEGORIES, type AutonomyLevel, type SectionProfile } from '@id/contracts';
import { catalog, checks } from '../../api/endpoints.js';
import { catalogKeys, adminKeys } from '../../api/keys.js';
import { describeError, isApiError } from '../../api/problem.js';
import { useSession } from '../../app/session.js';
import { EmptyState, ErrorState, ExplainedLimitation, LoadingState } from '../../shared/ui.js';
import { applyFieldErrors, type FieldPath } from '../../shared/formErrors.js';
import { ToneTag } from '../../shared/tags.js';

const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  assisted: 'с участием человека',
  automatic: 'автоматический',
};

/** Сегодняшняя дата по UTC — тот же умолчательный день, что берёт сервер. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function SectionProfilesPanel(): ReactNode {
  const { can } = useSession();
  const [sectionCode, setSectionCode] = useState<string | null>(null);
  const [at, setAt] = useState<string>(today);
  const [creating, setCreating] = useState(false);

  const sections = useQuery({
    queryKey: catalogKeys.sectionCatalog(false),
    queryFn: () => catalog.sections(),
  });

  const selected = sectionCode ?? sections.data?.[0]?.code ?? null;

  const profiles = useQuery({
    queryKey: catalogKeys.sectionProfiles(selected ?? 'none'),
    queryFn: () => catalog.sectionProfiles(selected ?? ''),
    enabled: selected !== null,
  });

  const effective = useQuery({
    queryKey: catalogKeys.effectiveSectionProfile(selected ?? 'none', at),
    queryFn: () => catalog.effectiveSectionProfile(selected ?? '', at),
    enabled: selected !== null,
    // 404 здесь — ответ «на эту дату профиля нет», и повторять запрос
    // бессмысленно: состояние не изменится само.
    retry: (failureCount, error) =>
      !(isApiError(error) && error.status === 404) && failureCount < 2,
  });

  if (sections.isPending) return <LoadingState label="Загрузка видов разделов…" />;
  if (sections.isError) return <ErrorState error={sections.error} />;
  if (sections.data.length === 0) return <EmptyState label="Разделы работ не заведены" />;

  const effectiveMissing =
    effective.isError && isApiError(effective.error) && effective.error.status === 404;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap align="end">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Раздел работ</span>
          {/*
            Поиск по списку включён намеренно: разделов двадцать четыре, и
            прокрутка виртуального списка до «Электромонтажных работ» — это
            работа, которую человек делает вместо ввода трёх букв.
          */}
          <Select<string>
            style={{ minWidth: 280 }}
            value={selected}
            onChange={setSectionCode}
            showSearch
            optionFilterProp="label"
            options={sections.data.map((row) => ({ value: row.code, label: row.name }))}
            aria-label="Раздел работ"
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>Действующий на дату</span>
          <Input
            type="date"
            value={at}
            onChange={(event) => setAt(event.target.value)}
            style={{ width: 180 }}
            aria-label="Дата, на которую нужен действующий профиль"
          />
        </div>
        {can('settings.manage') && (
          <Button
            type="primary"
            onClick={() => setCreating(true)}
            data-testid="new-section-profile"
          >
            Новая версия профиля
          </Button>
        )}
      </Space>

      <Card size="small" title={`Действующий профиль на ${at}`}>
        {effective.isPending && <LoadingState />}
        {effectiveMissing && (
          <ExplainedLimitation title="Профиль раздела не настроен" testId="profile-absent">
            На эту дату опубликованного профиля нет. Это не пустой список и не сбой: правила полноты
            обязаны отличать «раздел не настроен» от «комплект неполон» (§9.1) и в первом случае
            дают <Typography.Text code>n_a</Typography.Text>, а не замечание.
          </ExplainedLimitation>
        )}
        {effective.isError && !effectiveMissing && <ErrorState error={effective.error} />}
        {effective.isSuccess && <ProfileCard profile={effective.data} />}
      </Card>

      <Card size="small" title="Все версии профиля">
        {profiles.isPending && <LoadingState />}
        {profiles.isError && <ErrorState error={profiles.error} />}
        {profiles.isSuccess && (
          <ProfileVersions
            profiles={profiles.data}
            canPublish={can('settings.manage')}
            sectionCode={selected ?? ''}
          />
        )}
      </Card>

      {selected !== null && (
        <NewProfileDialog
          open={creating}
          sectionCode={selected}
          onClose={() => setCreating(false)}
        />
      )}
    </Space>
  );
}

function ProfileVersions({
  profiles,
  canPublish,
  sectionCode,
}: {
  profiles: readonly SectionProfile[];
  canPublish: boolean;
  sectionCode: string;
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();

  const publish = useMutation({
    mutationFn: (profileId: string) => catalog.publishSectionProfile(profileId),
    onSuccess: async (profile) => {
      message.success(`Профиль версии ${String(profile.version)} опубликован`);
      await queryClient.invalidateQueries({ queryKey: ['catalog', 'section-profiles'] });
    },
    onError: (error) => message.error(describeError(error)),
  });

  return (
    <Table<SectionProfile>
      rowKey="id"
      size="small"
      pagination={false}
      dataSource={[...profiles]}
      locale={{ emptyText: 'Версий профиля у этого раздела нет' }}
      expandable={{ expandedRowRender: (row) => <ProfileCard profile={row} /> }}
      columns={[
        { title: 'Версия', dataIndex: 'version', key: 'version', width: 90 },
        { title: 'Действует с', dataIndex: 'effectiveFrom', key: 'effectiveFrom' },
        {
          title: 'по',
          dataIndex: 'effectiveTo',
          key: 'effectiveTo',
          render: (value: string | null) => value ?? 'без ограничения',
        },
        {
          title: 'Состояние',
          key: 'state',
          render: (_value, row) =>
            row.publishedAt === null ? (
              <ToneTag tone="neutral">черновик</ToneTag>
            ) : (
              <ToneTag tone="success">опубликован {row.publishedAt.slice(0, 10)}</ToneTag>
            ),
        },
        {
          title: 'Автономия',
          dataIndex: 'autonomyLevel',
          key: 'autonomyLevel',
          render: (level: AutonomyLevel) => AUTONOMY_LABELS[level],
        },
        {
          title: 'Действия',
          key: 'actions',
          render: (_value, row) =>
            row.publishedAt === null && canPublish ? (
              <Button
                size="small"
                type="primary"
                loading={publish.isPending}
                onClick={() => publish.mutate(row.id)}
                data-testid={`publish-profile-${String(row.version)}`}
              >
                Опубликовать
              </Button>
            ) : (
              <Typography.Text type="secondary">
                {row.publishedAt === null ? 'нет права публикации' : 'версия неизменяема'}
              </Typography.Text>
            ),
        },
      ]}
      title={() => `Раздел работ: ${sectionCode}`}
    />
  );
}

/**
 * Состав профиля.
 *
 * Матрица материалов и пороги показываются как есть, JSON'ом: их форма задаётся
 * правилами §9.4 и растёт вместе с ними, а «красивая» таблица с фиксированными
 * колонками спрятала бы ключ, появившийся вчера.
 */
function ProfileCard({ profile }: { profile: SectionProfile }): ReactNode {
  return (
    <Descriptions size="small" column={1} bordered data-testid="section-profile-card">
      <Descriptions.Item label="Версия">
        {profile.version} ({profile.effectiveFrom} — {profile.effectiveTo ?? 'без ограничения'})
      </Descriptions.Item>
      <Descriptions.Item label="Ожидаемый состав документов">
        {profile.expectedDocTypes.length === 0 ? (
          <Typography.Text type="secondary">
            состав не задан: правила полноты по этому разделу не сработают
          </Typography.Text>
        ) : (
          <Space size={4} wrap>
            {profile.expectedDocTypes.map((code) => (
              <ToneTag key={code} tone="neutral">
                {code}
              </ToneTag>
            ))}
          </Space>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="Категории материалов">
        {profile.materialCategories.length === 0 ? (
          <Typography.Text type="secondary">категории не заданы</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {profile.materialCategories.map((code) => (
              <ToneTag key={code} tone="info">
                {code}
              </ToneTag>
            ))}
          </Space>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="Матрица материалов">
        <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(profile.materialMatrix, null, 2)}
        </Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label="Применимые правила">
        {profile.enabledRuleCodes.length === 0 ? (
          <Typography.Text type="secondary">правила не включены</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {profile.enabledRuleCodes.map((code) => (
              <ToneTag key={code} tone="accent">
                {code}
              </ToneTag>
            ))}
          </Space>
        )}
      </Descriptions.Item>
      <Descriptions.Item label="Пороги">
        <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(profile.thresholds, null, 2)}
        </Typography.Text>
      </Descriptions.Item>
      <Descriptions.Item label="Уровень автономии">
        {AUTONOMY_LABELS[profile.autonomyLevel]}
      </Descriptions.Item>
    </Descriptions>
  );
}

interface ProfileFormValues {
  effectiveFrom: string;
  effectiveTo: string;
  expectedDocTypes: string[];
  materialCategories: string[];
  enabledRuleCodes: string[];
  autonomyLevel: AutonomyLevel;
  publish: boolean;
}

/** Поля формы, на которые сервер умеет указывать 422 (`assertKnownProfileReferences`). */
const PROFILE_FIELDS: readonly FieldPath[] = [
  ['effectiveFrom'],
  ['effectiveTo'],
  ['expectedDocTypes'],
  ['materialCategories'],
  ['enabledRuleCodes'],
  ['autonomyLevel'],
];

function NewProfileDialog({
  open,
  sectionCode,
  onClose,
}: {
  open: boolean;
  sectionCode: string;
  onClose: () => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ProfileFormValues>();
  const [unmatched, setUnmatched] = useState<string[]>([]);

  const docTypes = useQuery({
    queryKey: catalogKeys.docTypes(false),
    queryFn: () => catalog.docTypes(false),
    enabled: open,
  });
  const rules = useQuery({
    queryKey: adminKeys.ruleCatalog(),
    queryFn: () => checks.ruleCatalog(),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: (values: ProfileFormValues) =>
      catalog.createSectionProfile({
        sectionCode,
        effectiveFrom: values.effectiveFrom,
        effectiveTo: values.effectiveTo === '' ? null : values.effectiveTo,
        expectedDocTypes: values.expectedDocTypes,
        materialCategories: values.materialCategories,
        enabledRuleCodes: values.enabledRuleCodes,
        autonomyLevel: values.autonomyLevel,
        publish: values.publish,
      }),
    onSuccess: async (profile) => {
      message.success(
        profile.publishedAt === null
          ? `Черновик версии ${String(profile.version)} создан`
          : `Версия ${String(profile.version)} создана и опубликована`,
      );
      setUnmatched([]);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['catalog', 'section-profiles'] });
      onClose();
    },
    onError: (error) => {
      // 422 подсвечивает поля по JSON Pointer: сообщение «ссылается на коды,
      // которых нет» без указания поля отправило бы искать опечатку вручную.
      const leftover = applyFieldErrors(form, error, PROFILE_FIELDS);
      setUnmatched(leftover.length > 0 ? leftover : [describeError(error)]);
    },
  });

  return (
    <Modal
      open={open}
      title="Новая версия профиля раздела"
      okText="Создать"
      cancelText="Отмена"
      confirmLoading={create.isPending}
      onCancel={() => {
        setUnmatched([]);
        onClose();
      }}
      onOk={() => {
        void form.validateFields().then((values) => create.mutate(values));
      }}
      destroyOnHidden
      width={720}
    >
      <Typography.Paragraph type="secondary">
        Номер версии назначает сервер. Публикация закрывает период предыдущей версии, поэтому
        черновик можно оставить и опубликовать позже — к тому моменту проверки будут выполнены
        заново.
      </Typography.Paragraph>

      {unmatched.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="Сервер отклонил профиль"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unmatched.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          }
        />
      )}

      <Form<ProfileFormValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{
          effectiveFrom: today(),
          effectiveTo: '',
          expectedDocTypes: [],
          materialCategories: [],
          enabledRuleCodes: [],
          autonomyLevel: 'assisted' as AutonomyLevel,
          publish: false,
        }}
      >
        <Form.Item
          name="effectiveFrom"
          label="Действует с"
          rules={[{ required: true, message: 'Дата начала обязательна' }]}
        >
          <Input type="date" />
        </Form.Item>
        <Form.Item name="effectiveTo" label="Действует по (пусто — без ограничения)">
          <Input type="date" />
        </Form.Item>
        <Form.Item name="expectedDocTypes" label="Ожидаемый состав документов">
          <Select
            mode="multiple"
            allowClear
            optionFilterProp="label"
            loading={docTypes.isPending}
            options={(docTypes.data ?? []).map((type) => ({
              value: type.code,
              label: `${type.code} — ${type.name}`,
            }))}
          />
        </Form.Item>
        <Form.Item name="materialCategories" label="Категории материалов">
          <Select
            mode="multiple"
            allowClear
            optionFilterProp="label"
            options={MATERIAL_CATEGORIES.map((code) => ({ value: code, label: code }))}
          />
        </Form.Item>
        <Form.Item name="enabledRuleCodes" label="Применимые правила">
          <Select
            mode="multiple"
            allowClear
            optionFilterProp="label"
            loading={rules.isPending}
            options={(rules.data ?? []).map((rule) => ({
              value: rule.code,
              label: `${rule.code} — ${rule.title}`,
            }))}
          />
        </Form.Item>
        <Form.Item name="autonomyLevel" label="Уровень автономии">
          <Select
            options={[
              { value: 'assisted', label: AUTONOMY_LABELS.assisted },
              { value: 'automatic', label: AUTONOMY_LABELS.automatic },
            ]}
          />
        </Form.Item>
        <Form.Item name="publish" valuePropName="checked">
          <Checkbox>Опубликовать сразу</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}
