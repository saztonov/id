/**
 * Том: поставки и их ревизии (§3, §14).
 *
 * Оба списка идут фактическими маршрутами навигации: `GET /api/v1/submissions`
 * с фильтром `volumeId` и `GET /api/v1/submissions/{id}/revisions`. Оба
 * курсорные, поэтому у обоих есть «показать ещё» — иначе первые 50 строк
 * выглядели бы полным перечнем.
 *
 * ## Два ограничения модели названы вслух, а не выключены молча
 *
 * **Первую поставку на объекте подрядчик завести не может.** Связи «подрядчик
 * закреплён за томом» в схеме нет вовсе: единственный признак закрепления —
 * уже существующая поставка, и потому область видимости подрядчика не
 * содержит объекта, где у него поставок ещё нет. Ослабить это на клиенте
 * нельзя и не нужно; можно только объяснить, иначе пользователь читает пустой
 * перечень объектов как поломку.
 *
 * **Пользователь с ролями подрядчика и инженера получает отказ на создании.**
 * Право `submission.upload` у него есть — оно выдано роли `contractor`, — а
 * область видимости строится по СТАРШЕЙ роли и организации не содержит.
 * Сервер отвечает 403, и это правильно: придумать организацию за него нельзя,
 * а взять её из тела запроса значило бы позволить подать от чужого имени.
 * Экран говорит это ДО нажатия, но кнопку не прячет: спрятанная кнопка учит
 * пользователя, что функции нет, вместо того чтобы объяснить, почему она
 * недоступна ему.
 */
import { useState, type ReactNode } from 'react';
import { App as AntApp, Button, Card, Descriptions, Form, Input, Space, Table, Tag } from 'antd';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { navigationKeys } from '../../api/keys.js';
import {
  createRevision,
  createSubmission,
  getVolume,
  listRevisions,
  listSubmissions,
  pagesBlocked,
  pagesItems,
  type Submission,
  type SubmissionRevisionSummary,
} from '../../api/navigation.js';
import {
  ErrorState,
  ExplainedLimitation,
  LoadingState,
  ScreenHeading,
  UnavailableState,
} from '../../shared/ui.js';
import { WORKFLOW_STATUS_LABELS, labelOf } from '../../shared/labels.js';
import { Link, useNavigate } from '../../app/router.js';
import { useSession } from '../../app/session.js';

export function VolumeSubmissionsScreen({ volumeId }: { volumeId: string }): ReactNode {
  const volume = useQuery({
    queryKey: navigationKeys.volume(volumeId),
    queryFn: () => getVolume(volumeId),
  });

  const submissions = useInfiniteQuery({
    queryKey: navigationKeys.submissions(volumeId),
    queryFn: ({ pageParam }) => listSubmissions({ volumeId, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.kind === 'available' ? last.data.nextCursor : null),
  });

  const blocked = pagesBlocked(submissions.data?.pages);
  const items = pagesItems(submissions.data?.pages);
  const volumeData = volume.data?.kind === 'available' ? volume.data.data : null;

  return (
    <>
      <ScreenHeading
        title={volumeData === null ? 'Поставки тома' : `${volumeData.code} — ${volumeData.name}`}
      />

      {volume.isPending && <LoadingState label="Загрузка тома…" />}
      {volume.isError && <ErrorState error={volume.error} title="Том недоступен" />}
      {volume.data?.kind === 'unavailable' && (
        <UnavailableState
          route={volume.data.route}
          what="Том"
          reason={volume.data.reason}
          detail={volume.data.detail}
        />
      )}

      {volumeData !== null && (
        <Descriptions size="small" column={2} bordered style={{ marginBottom: 24 }}>
          <Descriptions.Item label="Объект">
            <Link to={`/ids/objects/${volumeData.objectId}`}>Перейти к объекту</Link>
          </Descriptions.Item>
          <Descriptions.Item label="Состояние">
            <span data-testid="volume-state">{volumeData.isActive ? 'Открыт' : 'Закрыт'}</span>
          </Descriptions.Item>
        </Descriptions>
      )}

      <NewSubmissionCard volumeId={volumeId} volumeIsActive={volumeData?.isActive ?? null} />

      {submissions.isPending && <LoadingState label="Загрузка поставок…" />}
      {submissions.isError && <ErrorState error={submissions.error} />}
      {blocked !== null && (
        <UnavailableState
          route={blocked.route}
          what="Поставки тома"
          reason={blocked.reason}
          detail={blocked.detail}
        />
      )}
      {submissions.isSuccess && blocked === null && (
        <>
          <Table<Submission>
            rowKey="id"
            size="middle"
            pagination={false}
            dataSource={items}
            locale={{ emptyText: 'Поставок по тому нет' }}
            columns={[
              { title: 'Номер', dataIndex: 'number', key: 'number', render: (v) => v ?? '—' },
              { title: 'Наименование', dataIndex: 'title', key: 'title' },
              {
                title: 'Текущая ревизия',
                dataIndex: 'currentRevisionId',
                key: 'currentRevisionId',
                render: (revisionId: string | null) =>
                  revisionId === null ? (
                    '—'
                  ) : (
                    <Link to={`/ids/revisions/${revisionId}`}>Открыть</Link>
                  ),
              },
            ]}
          />
          {submissions.hasNextPage && (
            <Button
              style={{ marginTop: 12 }}
              data-testid="submissions-more"
              loading={submissions.isFetchingNextPage}
              onClick={() => {
                void submissions.fetchNextPage();
              }}
            >
              Показать ещё поставки
            </Button>
          )}
          {items.map((submission) => (
            <RevisionsCard key={submission.id} submission={submission} />
          ))}
        </>
      )}
    </>
  );
}

/**
 * Создание поставки: форма и объяснение того, почему она может не сработать.
 *
 * Карточка показывается тем, у кого есть `submission.upload`, — то есть по
 * ролям. Отдельно проверяется ОБЛАСТЬ: право и область — разные вещи, и именно
 * их расхождение даёт 403 у пользователя с ролями подрядчика и инженера.
 */
function NewSubmissionCard({
  volumeId,
  volumeIsActive,
}: {
  volumeId: string;
  volumeIsActive: boolean | null;
}): ReactNode {
  const { can, me } = useSession();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ title: string; number?: string }>();
  const [failure, setFailure] = useState<unknown>(null);

  const scopeKind = me.scope?.kind ?? null;
  const scopeHasOrganization = scopeKind === 'contractor';

  const mutation = useMutation({
    mutationFn: (values: { title: string; number?: string }) =>
      createSubmission({
        volumeId,
        title: values.title,
        ...(values.number === undefined || values.number === '' ? {} : { number: values.number }),
      }),
    onSuccess: (created) => {
      setFailure(null);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: navigationKeys.submissions(volumeId) });
      void message.success('Поставка создана вместе с первой ревизией');
      navigate(`/ids/revisions/${created.revision.id}`);
    },
    onError: (error: unknown) => {
      // Отказ показывается на месте формы, а не всплывашкой: причина отказа —
      // часть объяснения ограничения, и она обязана оставаться на экране.
      setFailure(error);
    },
  });

  if (!can('submission.upload')) return null;

  return (
    <Card size="small" title="Новая поставка" style={{ marginBottom: 24 }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {!scopeHasOrganization && (
          <ExplainedLimitation
            title="Создание поставки будет отклонено сервером"
            testId="create-blocked-scope"
          >
            Право на загрузку у вас есть — оно выдано роли подрядчика. Но организация поставки
            берётся из области видимости, а не из тела запроса, и ваша область построена по старшей
            роли ({scopeKind ?? 'не определена'}) и организации не содержит. Придумать её за вас
            нельзя: поставка ушла бы от чужого имени.
          </ExplainedLimitation>
        )}

        <ExplainedLimitation
          title="Первую поставку на объекте через портал завести нельзя"
          testId="first-submission-limit"
        >
          В схеме нет связи «подрядчик закреплён за томом»: единственный признак закрепления — уже
          существующая поставка. Поэтому объект, где у вашей организации поставок ещё нет, не
          попадает в область видимости, и его томов в портале не видно. Первую поставку заводит
          администратор портала; дальше том доступен как обычно.
        </ExplainedLimitation>

        {volumeIsActive === false && (
          <ExplainedLimitation title="Том закрыт" testId="volume-closed">
            Подать в закрытый том новую поставку нельзя: сервер отвечает 409.
          </ExplainedLimitation>
        )}

        {failure !== null && <ErrorState error={failure} title="Поставка не создана" />}

        <Form
          form={form}
          layout="inline"
          onFinish={(values) => {
            mutation.mutate(values);
          }}
        >
          <Form.Item
            name="title"
            label="Наименование"
            rules={[{ required: true, message: 'Наименование обязательно' }]}
          >
            <Input style={{ width: 320 }} data-testid="new-submission-title" />
          </Form.Item>
          <Form.Item name="number" label="Номер">
            <Input style={{ width: 140 }} data-testid="new-submission-number" />
          </Form.Item>
          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={mutation.isPending}
              disabled={volumeIsActive === false}
              data-testid="create-submission"
            >
              Создать поставку
            </Button>
          </Form.Item>
        </Form>
      </Space>
    </Card>
  );
}

function RevisionsCard({ submission }: { submission: Submission }): ReactNode {
  const { can } = useSession();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<unknown>(null);

  const revisions = useInfiniteQuery({
    queryKey: navigationKeys.revisions(submission.id),
    queryFn: ({ pageParam }) => listRevisions(submission.id, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.kind === 'available' ? last.data.nextCursor : null),
  });

  const open = useMutation({
    mutationFn: () => createRevision(submission.id),
    onSuccess: () => {
      setFailure(null);
      void queryClient.invalidateQueries({ queryKey: navigationKeys.revisions(submission.id) });
      void message.success('Открыта следующая ревизия');
    },
    onError: (error: unknown) => {
      // 409 «черновик уже открыт» / «решение не принято» / «следующую создал
      // возврат» — это ответ сервера о состоянии, и он показывается дословно.
      setFailure(error);
    },
  });

  const blocked = pagesBlocked(revisions.data?.pages);
  const items = pagesItems(revisions.data?.pages);

  return (
    <Card
      size="small"
      title={`Ревизии: ${submission.title}`}
      style={{ marginTop: 16 }}
      extra={
        can('submission.upload') ? (
          <Button
            size="small"
            loading={open.isPending}
            data-testid={`open-revision-${submission.id}`}
            onClick={() => {
              open.mutate();
            }}
          >
            Открыть следующую ревизию
          </Button>
        ) : null
      }
    >
      {revisions.isPending && <LoadingState label="Загрузка ревизий…" />}
      {revisions.isError && <ErrorState error={revisions.error} />}
      {failure !== null && (
        <div style={{ marginBottom: 12 }} data-testid={`revision-conflict-${submission.id}`}>
          <ErrorState error={failure} title="Следующая ревизия не открыта" />
        </div>
      )}
      {blocked !== null && (
        <UnavailableState
          route={blocked.route}
          what="Ревизии поставки"
          reason={blocked.reason}
          detail={blocked.detail}
        />
      )}
      {revisions.isSuccess && blocked === null && (
        <>
          <Table<SubmissionRevisionSummary>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={items}
            locale={{ emptyText: 'Ревизий нет' }}
            columns={[
              {
                title: '№',
                dataIndex: 'revisionNo',
                key: 'revisionNo',
                render: (no: number, row) => <Link to={`/ids/revisions/${row.id}`}>{no}</Link>,
              },
              {
                title: 'Статус',
                dataIndex: 'status',
                key: 'status',
                render: (status: string) => <Tag>{labelOf(WORKFLOW_STATUS_LABELS, status)}</Tag>,
              },
              { title: 'Создана', dataIndex: 'createdAt', key: 'createdAt' },
              {
                title: 'Подана',
                dataIndex: 'submittedAt',
                key: 'submittedAt',
                render: (value: string | null) => value ?? '—',
              },
            ]}
          />
          {revisions.hasNextPage && (
            <Button
              style={{ marginTop: 12 }}
              size="small"
              loading={revisions.isFetchingNextPage}
              onClick={() => {
                void revisions.fetchNextPage();
              }}
            >
              Показать ещё ревизии
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
