/**
 * Правила и наборы правил (§3.7, §9, §14).
 *
 * ## Опубликованная версия неизменяема, поэтому «изменить» здесь нет
 *
 * `ruleset_rules` — снимок версии: прогон месячной давности воспроизводится
 * точно, потому что ссылается на версию по идентификатору, а её состав не
 * меняется никогда. Отсюда две вещи, которые легко перепутать:
 *
 * * **публикация** — это создание НОВОЙ версии со снимком целиком, а не правка
 *   существующей;
 * * **откат** — это переключение указателя действующей версии на прежнюю, а не
 *   восстановление её содержимого. Все выполненные прогоны продолжают
 *   ссылаться на ту версию, по которой считались, и результат месячной давности
 *   не переписывается задним числом.
 *
 * Кнопки названы ровно этими словами. «Сохранить» и «Откатить изменения»
 * обещали бы операции, которых у неизменяемой версии не существует.
 *
 * ## Снимок собирается из реестра правил, а не из воздуха
 *
 * Сервер отвергает снимок, ссылающийся на незаведённое правило (422 со списком
 * кодов). Поэтому форма публикации предлагает ровно то, что есть в реестре
 * `GET /admin/rules`, а умолчания важности берёт из каталога правил — того же,
 * по которому движок решает, даст ли правило вывод или `n_a` (§9.1).
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Severity } from '@id/contracts';
import { admin, checks } from '../../api/endpoints.js';
import { adminKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type {
  RuleCatalogEntry,
  RuleDefinition,
  RulesetRule,
  RulesetRuleInput,
  RulesetVersion,
} from '../../api/types.js';
import { useSession } from '../../app/session.js';
import { ErrorState, LoadingState, UnavailableState } from '../../shared/ui.js';
import { SEVERITY_LABELS } from '../../shared/labels.js';
import { ToneTag } from '../../shared/tags.js';
import { applyFieldErrors, type FieldPath } from '../../shared/formErrors.js';

export function RulesPanel(): ReactNode {
  const { can } = useSession();

  // Право `rules.publish` закрывает ВЕСЬ раздел на сервере, включая чтение
  // реестра. Показать пустые таблицы значило бы выдать отказ в правах за
  // отсутствие данных — ровно то различие, ради которого сделан `UnavailableState`.
  if (!can('rules.publish')) {
    return (
      <UnavailableState
        route="GET /api/v1/admin/rulesets"
        what="Правила и наборы правил"
        reason="forbidden"
        detail="Раздел требует права rules.publish: им закрыты и чтение реестра, и публикация."
      />
    );
  }

  return <RulesWorkspace />;
}

function RulesWorkspace(): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [publishing, setPublishing] = useState(false);
  const [openedVersion, setOpenedVersion] = useState<string | null>(null);

  const rulesets = useQuery({ queryKey: adminKeys.rulesets(), queryFn: () => admin.rulesets() });
  const registry = useQuery({ queryKey: adminKeys.rules(), queryFn: () => admin.rules() });
  const catalogQuery = useQuery({
    queryKey: adminKeys.ruleCatalog(),
    queryFn: () => checks.ruleCatalog(),
  });

  const activate = useMutation({
    mutationFn: (rulesetId: string) => admin.activateRuleset(rulesetId),
    onSuccess: async (version) => {
      message.success(`Действующей стала версия ${version.version}`);
      await queryClient.invalidateQueries({ queryKey: adminKeys.rulesets() });
    },
    onError: (error) => message.error(describeError(error)),
  });

  const active = (rulesets.data?.items ?? []).find((item) => item.isActive) ?? null;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title="Версии набора правил"
        extra={
          <Button
            type="primary"
            onClick={() => setPublishing(true)}
            disabled={registry.isPending || registry.isError}
            data-testid="publish-ruleset"
          >
            Опубликовать новую версию
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Действующая версия:{' '}
          {active === null ? (
            <Typography.Text strong>не назначена — прогоны идут без снимка</Typography.Text>
          ) : (
            <Typography.Text strong data-testid="active-ruleset">
              {active.version}
            </Typography.Text>
          )}
        </Typography.Paragraph>

        {rulesets.isPending && <LoadingState />}
        {rulesets.isError && <ErrorState error={rulesets.error} />}
        {rulesets.isSuccess && (
          <Table<RulesetVersion>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={rulesets.data.items}
            locale={{ emptyText: 'Наборы правил не публиковались' }}
            expandable={{
              expandedRowKeys: openedVersion === null ? [] : [openedVersion],
              onExpand: (expanded, row) => setOpenedVersion(expanded ? row.id : null),
              expandedRowRender: (row) => <RulesetSnapshot rulesetId={row.id} />,
            }}
            columns={[
              { title: 'Версия', dataIndex: 'version', key: 'version' },
              {
                title: 'Состояние',
                key: 'state',
                render: (_value, row) => (
                  <Space size={4}>
                    <ToneTag tone={row.state === 'published' ? 'success' : 'neutral'}>
                      {row.state === 'published' ? 'опубликован' : 'черновик'}
                    </ToneTag>
                    {row.isActive && <ToneTag tone="info">действующий</ToneTag>}
                  </Space>
                ),
              },
              { title: 'Правил в снимке', dataIndex: 'ruleCount', key: 'ruleCount' },
              {
                title: 'Опубликован',
                dataIndex: 'publishedAt',
                key: 'publishedAt',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: 'Примечание',
                dataIndex: 'notes',
                key: 'notes',
                render: (value: string | null) => value ?? '—',
              },
              {
                title: 'Действия',
                key: 'actions',
                render: (_value, row) =>
                  row.isActive ? (
                    <Typography.Text type="secondary">уже действует</Typography.Text>
                  ) : row.state !== 'published' ? (
                    <Typography.Text type="secondary">
                      черновик действующим не делают
                    </Typography.Text>
                  ) : (
                    <Popconfirm
                      title={`Сделать действующей версию ${row.version}?`}
                      description={
                        'Это откат указателя, а не правка: выполненные прогоны останутся ' +
                        'привязанными к своим версиям.'
                      }
                      okText="Сделать действующей"
                      cancelText="Отмена"
                      onConfirm={() => activate.mutate(row.id)}
                    >
                      <Button
                        size="small"
                        loading={activate.isPending}
                        data-testid={`activate-ruleset-${row.version}`}
                      >
                        Сделать действующей
                      </Button>
                    </Popconfirm>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="Реестр правил">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Снимок версии может ссылаться только на эти коды: правило вне реестра сервер отвергнет
          целиком, а не пропустит молча.
        </Typography.Paragraph>
        {registry.isPending && <LoadingState />}
        {registry.isError && <ErrorState error={registry.error} />}
        {registry.isSuccess && (
          <Table<RuleDefinition>
            rowKey="code"
            size="small"
            pagination={false}
            dataSource={registry.data}
            locale={{ emptyText: 'Реестр правил пуст' }}
            columns={[
              { title: 'Код', dataIndex: 'code', key: 'code' },
              { title: 'Название', dataIndex: 'title', key: 'title' },
              { title: 'Уровень', dataIndex: 'level', key: 'level' },
              { title: 'Вид', dataIndex: 'kind', key: 'kind' },
              {
                title: 'Важность по умолчанию',
                dataIndex: 'defaultSeverity',
                key: 'defaultSeverity',
                render: (severity: Severity) => SEVERITY_LABELS[severity],
              },
              {
                title: 'Кто вправе списать',
                dataIndex: 'waiverRoles',
                key: 'waiverRoles',
                render: (roles: string[]) =>
                  roles.length === 0 ? 'никто: списание запрещено' : roles.join(', '),
              },
            ]}
          />
        )}
      </Card>

      <Card size="small" title="Каталог правил с умолчаниями">
        {catalogQuery.isPending && <LoadingState />}
        {catalogQuery.isError && <ErrorState error={catalogQuery.error} />}
        {catalogQuery.isSuccess && (
          <Table<RuleCatalogEntry>
            rowKey="code"
            size="small"
            pagination={false}
            dataSource={catalogQuery.data}
            locale={{ emptyText: 'Каталог правил пуст' }}
            columns={[
              { title: 'Код', dataIndex: 'code', key: 'code' },
              { title: 'Название', dataIndex: 'title', key: 'title' },
              {
                title: 'Вид ИД',
                dataIndex: 'docTypeCode',
                key: 'docTypeCode',
                render: (value: string | null) => value ?? 'любой',
              },
              {
                title: 'По умолчанию',
                key: 'defaults',
                render: (_value, row) => (
                  <Space size={4}>
                    <ToneTag tone="neutral">{SEVERITY_LABELS[row.defaultSeverity]}</ToneTag>
                    {row.defaultBlocking && <ToneTag tone="danger">блокирует</ToneTag>}
                  </Space>
                ),
              },
              {
                title: 'Требует',
                key: 'requires',
                render: (_value, row) => (
                  <Space size={4} wrap>
                    {row.requiresSectionProfile && (
                      <ToneTag tone="warning">профиль раздела</ToneTag>
                    )}
                    {row.requiresExternalRegistry !== null && (
                      <ToneTag tone="warning">реестр {row.requiresExternalRegistry}</ToneTag>
                    )}
                    {!row.requiresSectionProfile && row.requiresExternalRegistry === null && '—'}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      <PublishDialog
        open={publishing}
        registry={registry.data ?? []}
        catalog={catalogQuery.data ?? []}
        onClose={() => setPublishing(false)}
      />
    </Space>
  );
}

/** Снимок версии: то, по чему считался каждый прогон, сославшийся на неё. */
function RulesetSnapshot({ rulesetId }: { rulesetId: string }): ReactNode {
  const detail = useQuery({
    queryKey: adminKeys.ruleset(rulesetId),
    queryFn: () => admin.ruleset(rulesetId),
  });

  if (detail.isPending) return <LoadingState label="Загрузка снимка…" />;
  if (detail.isError) return <ErrorState error={detail.error} />;

  return (
    <Table<RulesetRule>
      rowKey="ruleCode"
      size="small"
      pagination={false}
      dataSource={detail.data.rules}
      locale={{ emptyText: 'Снимок пуст' }}
      columns={[
        { title: 'Правило', dataIndex: 'ruleCode', key: 'ruleCode' },
        {
          title: 'Включено',
          dataIndex: 'isEnabled',
          key: 'isEnabled',
          render: (value: boolean) => (value ? 'да' : 'нет'),
        },
        {
          title: 'Важность',
          dataIndex: 'severity',
          key: 'severity',
          render: (severity: Severity) => SEVERITY_LABELS[severity],
        },
        {
          title: 'Блокирует',
          dataIndex: 'isBlocking',
          key: 'isBlocking',
          render: (value: boolean) => (value ? 'да' : 'нет'),
        },
        {
          title: 'Параметры',
          dataIndex: 'params',
          key: 'params',
          render: (value: unknown) => (
            <Typography.Text code>{JSON.stringify(value)}</Typography.Text>
          ),
        },
      ]}
    />
  );
}

interface PublishFormValues {
  version: string;
  notes: string;
  activate: boolean;
}

/** Поля, на которые сервер указывает в 422 (`/rules`, `/version`). */
const PUBLISH_FIELDS: readonly FieldPath[] = [['version'], ['notes'], ['rules']];

function PublishDialog({
  open,
  registry,
  catalog,
  onClose,
}: {
  open: boolean;
  registry: readonly RuleDefinition[];
  catalog: readonly RuleCatalogEntry[];
  onClose: () => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<PublishFormValues>();
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Partial<RulesetRuleInput>>>({});

  const defaults = useMemo(() => {
    const byCode = new Map(catalog.map((entry) => [entry.code, entry]));
    return registry.map<RulesetRuleInput>((rule) => {
      const entry = byCode.get(rule.code);
      return {
        ruleCode: rule.code,
        isEnabled: true,
        severity: entry?.defaultSeverity ?? rule.defaultSeverity,
        isBlocking: entry?.defaultBlocking ?? false,
      };
    });
  }, [registry, catalog]);

  const snapshot = useMemo(
    () => defaults.map((rule) => ({ ...rule, ...overrides[rule.ruleCode] })),
    [defaults, overrides],
  );

  const publish = useMutation({
    mutationFn: (values: PublishFormValues) =>
      admin.publishRuleset({
        version: values.version.trim(),
        notes: values.notes.trim() === '' ? null : values.notes.trim(),
        activate: values.activate,
        rules: snapshot,
      }),
    onSuccess: async (version) => {
      message.success(
        version.isActive
          ? `Версия ${version.version} опубликована и стала действующей`
          : `Версия ${version.version} опубликована; действующей она не назначена`,
      );
      setUnmatched([]);
      setOverrides({});
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: adminKeys.rulesets() });
      onClose();
    },
    onError: (error) => {
      const leftover = applyFieldErrors(form, error, PUBLISH_FIELDS);
      setUnmatched(leftover.length > 0 ? leftover : [describeError(error)]);
    },
  });

  const patch = (code: string, value: Partial<RulesetRuleInput>): void => {
    setOverrides((previous) => ({ ...previous, [code]: { ...previous[code], ...value } }));
  };

  return (
    <Modal
      open={open}
      title="Публикация версии набора правил"
      okText="Опубликовать"
      cancelText="Отмена"
      confirmLoading={publish.isPending}
      onCancel={() => {
        setUnmatched([]);
        onClose();
      }}
      onOk={() => {
        void form.validateFields().then((values) => publish.mutate(values));
      }}
      destroyOnHidden
      width={900}
    >
      <Typography.Paragraph type="secondary">
        Публикуется снимок целиком: версия обязана быть самодостаточной, иначе прогон месячной
        давности воспроизводится только вместе с историей правок реестра. Опубликованную версию
        нельзя изменить — новая правка это новая версия под новой меткой.
      </Typography.Paragraph>

      {unmatched.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="Сервер отклонил публикацию"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unmatched.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          }
        />
      )}

      <Form<PublishFormValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ version: '', notes: '', activate: true }}
      >
        <Form.Item
          name="version"
          label="Метка версии"
          rules={[
            { required: true, message: 'Метка версии обязательна' },
            {
              pattern: /^[0-9A-Za-z][0-9A-Za-z._-]*$/,
              message: 'Латиница, цифры, точка, дефис, подчёркивание',
            },
          ]}
        >
          <Input placeholder="2026.08.2" data-testid="ruleset-version" />
        </Form.Item>
        <Form.Item name="notes" label="Примечание">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="activate" valuePropName="checked">
          <Checkbox>Сделать действующей сразу</Checkbox>
        </Form.Item>
      </Form>

      <Table<RulesetRuleInput>
        rowKey="ruleCode"
        size="small"
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
        dataSource={snapshot}
        title={() => `Снимок: правил ${String(snapshot.length)}`}
        locale={{ emptyText: 'Реестр правил пуст — публиковать нечего' }}
        columns={[
          { title: 'Правило', dataIndex: 'ruleCode', key: 'ruleCode' },
          {
            title: 'Включено',
            key: 'isEnabled',
            render: (_value, row) => (
              <Checkbox
                checked={row.isEnabled}
                onChange={(event) => patch(row.ruleCode, { isEnabled: event.target.checked })}
                aria-label={`Правило ${row.ruleCode} включено`}
              />
            ),
          },
          {
            title: 'Важность',
            key: 'severity',
            render: (_value, row) => (
              <Select<Severity>
                size="small"
                style={{ width: 160 }}
                value={row.severity}
                onChange={(severity) => patch(row.ruleCode, { severity })}
                options={(['error', 'warning', 'info'] as Severity[]).map((severity) => ({
                  value: severity,
                  label: SEVERITY_LABELS[severity],
                }))}
                aria-label={`Важность правила ${row.ruleCode}`}
              />
            ),
          },
          {
            title: 'Блокирует',
            key: 'isBlocking',
            render: (_value, row) => (
              <Checkbox
                checked={row.isBlocking}
                onChange={(event) => patch(row.ruleCode, { isBlocking: event.target.checked })}
                aria-label={`Правило ${row.ruleCode} блокирует согласование`}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}
