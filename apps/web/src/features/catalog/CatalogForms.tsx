/**
 * Формы заведения и правки объектов и контрагентов (§3.2, §14).
 *
 * ## Отказ сервера показывается на поле, а не всплывашкой
 *
 * Вход справочника проверяет контрольные суммы ИНН, КПП и ОГРН и отвечает 422 с
 * JSON Pointer на поле. Свернуть этот ответ в одну строку значит потерять ровно
 * ту его часть, ради которой он и формируется: администратор получил бы
 * «проверьте реквизиты» и сам искал бы, в каком из трёх полей опечатка. Поэтому
 * `applyFieldErrors` разносит сообщения по полям, а то, чему поля не нашлось,
 * остаётся видимым блоком — молча проглоченное объяснение отказа это отказ без
 * объяснения.
 *
 * Тексты сообщений приходят с сервера и здесь не переписываются: «контрольная
 * сумма не сходится» и «ИНН — 10 или 12 цифр» это разные действия человека, и
 * различает их вход справочника, а не форма.
 *
 * ## Код объекта правится только заведением нового
 *
 * В теле `PATCH` его нет: код печатается в номерах актов и участвует в
 * именовании выгрузок, поэтому смена задним числом рассогласовала бы уже
 * выданные документы с карточкой. Форма правки показывает его отключённым и
 * говорит почему — иначе поле выглядит сломанным.
 */
import { useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Form, Input, Modal, Select, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { catalog, type CounterpartyInput, type ObjectInput } from '../../api/endpoints.js';
import { catalogKeys } from '../../api/keys.js';
import { describeError } from '../../api/problem.js';
import type { ConstructionObject, Counterparty } from '../../api/types.js';
import { applyFieldErrors, type FieldPath } from '../../shared/formErrors.js';

/** Пустая строка формы означает «не задано», а не пустое значение реквизита. */
function orNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Общий сброс кэша справочника после любой правки. */
function useCatalogInvalidate(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ['catalog'] });
  };
}

// =====================================================================
// Контрагент
// =====================================================================

interface CounterpartyFormValues {
  name: string;
  kind: string;
  inn?: string;
  kpp?: string;
  ogrn?: string;
  legalAddress?: string;
}

const COUNTERPARTY_FIELDS: readonly FieldPath[] = [
  ['name'],
  ['kind'],
  ['inn'],
  ['kpp'],
  ['ogrn'],
  ['legalAddress'],
];

export function CounterpartyDialog({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  /** `null` — заведение новой карточки. */
  editing: Counterparty | null;
  onClose: () => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const invalidate = useCatalogInvalidate();
  const [form] = Form.useForm<CounterpartyFormValues>();
  const [unmatched, setUnmatched] = useState<string[]>([]);

  const kinds = useQuery({
    queryKey: catalogKeys.counterpartyKinds(),
    queryFn: () => catalog.counterpartyKinds(),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: (values: CounterpartyFormValues) => {
      const body: CounterpartyInput = {
        name: values.name.trim(),
        kind: values.kind,
        inn: orNull(values.inn),
        kpp: orNull(values.kpp),
        ogrn: orNull(values.ogrn),
        legalAddress: orNull(values.legalAddress),
      };
      return editing === null
        ? catalog.createCounterparty(body)
        : catalog.updateCounterparty(editing.id, body);
    },
    onSuccess: async (saved) => {
      message.success(
        editing === null ? `Контрагент «${saved.name}» заведён` : 'Изменения сохранены',
      );
      setUnmatched([]);
      form.resetFields();
      await invalidate();
      onClose();
    },
    onError: (error) => {
      const leftover = applyFieldErrors(form, error, COUNTERPARTY_FIELDS);
      setUnmatched(leftover.length > 0 ? leftover : [describeError(error)]);
    },
  });

  // Отключённый вид не предлагается, но у уже заведённой карточки остаётся в
  // списке: иначе правка адреса молча меняла бы вид организации.
  const options = (kinds.data ?? [])
    .filter((kind) => kind.isActive || kind.code === editing?.kind)
    .map((kind) => ({ value: kind.code, label: kind.name }));

  return (
    <Modal
      open={open}
      title={editing === null ? 'Новый контрагент' : `Контрагент: ${editing.name}`}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={save.isPending}
      onCancel={() => {
        setUnmatched([]);
        onClose();
      }}
      onOk={() => {
        void form.validateFields().then((values) => {
          save.mutate(values);
        });
      }}
      destroyOnHidden
      width={640}
    >
      {unmatched.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="Сервер отклонил карточку"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unmatched.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          }
        />
      )}

      <Form<CounterpartyFormValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={
          editing === null
            ? { kind: undefined }
            : {
                name: editing.name,
                kind: editing.kind,
                inn: editing.inn ?? '',
                kpp: editing.kpp ?? '',
                ogrn: editing.ogrn ?? '',
                legalAddress: editing.legalAddress ?? '',
              }
        }
      >
        <Form.Item
          name="name"
          label="Наименование"
          rules={[{ required: true, message: 'Наименование обязательно' }]}
        >
          <Input maxLength={500} data-testid="counterparty-name" />
        </Form.Item>
        <Form.Item
          name="kind"
          label="Вид"
          rules={[{ required: true, message: 'Вид обязателен' }]}
          extra="Основной вид деятельности организации, а не её роль в конкретной работе"
        >
          <Select options={options} loading={kinds.isPending} data-testid="counterparty-kind" />
        </Form.Item>
        <Form.Item name="inn" label="ИНН">
          <Input maxLength={12} data-testid="counterparty-inn" />
        </Form.Item>
        <Form.Item name="kpp" label="КПП">
          <Input maxLength={9} />
        </Form.Item>
        <Form.Item name="ogrn" label="ОГРН">
          <Input maxLength={15} />
        </Form.Item>
        <Form.Item name="legalAddress" label="Юридический адрес">
          <Input maxLength={1000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// =====================================================================
// Объект строительства
// =====================================================================

interface ObjectFormValues {
  code: string;
  name: string;
  fullName: string;
  address?: string;
  cadastralNumber?: string;
  permitIdentifier?: string;
  actNumberPattern?: string;
  developerId?: string;
  techCustomerId?: string;
  generalContractorId?: string;
}

const OBJECT_FIELDS: readonly FieldPath[] = [
  ['code'],
  ['name'],
  ['fullName'],
  ['address'],
  ['cadastralNumber'],
  ['permitIdentifier'],
  ['actNumberPattern'],
  ['developerId'],
  ['techCustomerId'],
  ['generalContractorId'],
];

export function ObjectDialog({
  open,
  editing,
  onClose,
}: {
  open: boolean;
  editing: ConstructionObject | null;
  onClose: () => void;
}): ReactNode {
  const { message } = AntApp.useApp();
  const invalidate = useCatalogInvalidate();
  const [form] = Form.useForm<ObjectFormValues>();
  const [unmatched, setUnmatched] = useState<string[]>([]);

  const parties = useQuery({
    queryKey: catalogKeys.counterparties('', ''),
    queryFn: () => catalog.counterparties(),
    enabled: open,
  });

  const partyOptions = (parties.data?.items ?? [])
    .filter((party) => party.isActive)
    .map((party) => ({
      value: party.id,
      label: party.inn === null ? party.name : `${party.name} (ИНН ${party.inn})`,
    }));

  const save = useMutation({
    mutationFn: (values: ObjectFormValues) => {
      const common = {
        name: values.name.trim(),
        fullName: values.fullName.trim(),
        address: orNull(values.address),
        cadastralNumber: orNull(values.cadastralNumber),
        permitIdentifier: orNull(values.permitIdentifier),
        actNumberPattern: orNull(values.actNumberPattern),
        developerId: values.developerId ?? null,
        techCustomerId: values.techCustomerId ?? null,
        generalContractorId: values.generalContractorId ?? null,
      };
      if (editing === null) {
        const body: ObjectInput = { code: values.code.trim(), ...common };
        return catalog.createObject(body);
      }
      return catalog.updateObject(editing.id, common);
    },
    onSuccess: async (saved) => {
      message.success(editing === null ? `Объект ${saved.code} заведён` : 'Изменения сохранены');
      setUnmatched([]);
      form.resetFields();
      await invalidate();
      onClose();
    },
    onError: (error) => {
      const leftover = applyFieldErrors(form, error, OBJECT_FIELDS);
      setUnmatched(leftover.length > 0 ? leftover : [describeError(error)]);
    },
  });

  return (
    <Modal
      open={open}
      title={editing === null ? 'Новый объект строительства' : `Объект ${editing.code}`}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={save.isPending}
      onCancel={() => {
        setUnmatched([]);
        onClose();
      }}
      onOk={() => {
        void form.validateFields().then((values) => {
          save.mutate(values);
        });
      }}
      destroyOnHidden
      width={720}
    >
      {unmatched.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="Сервер отклонил карточку"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unmatched.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          }
        />
      )}

      <Form<ObjectFormValues>
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={
          editing === null
            ? {}
            : {
                code: editing.code,
                name: editing.name,
                fullName: editing.fullName,
                address: editing.address ?? '',
                cadastralNumber: editing.cadastralNumber ?? '',
                permitIdentifier: editing.permitIdentifier ?? '',
                actNumberPattern: editing.actNumberPattern ?? '',
                developerId: editing.developerId ?? undefined,
                techCustomerId: editing.techCustomerId ?? undefined,
                generalContractorId: editing.generalContractorId ?? undefined,
              }
        }
      >
        <Form.Item
          name="code"
          label="Код"
          rules={
            editing === null
              ? [
                  { required: true, message: 'Код обязателен' },
                  {
                    pattern: /^[A-Za-z0-9]{5}$/u,
                    message: 'Код — ровно 5 латинских букв или цифр',
                  },
                ]
              : []
          }
          extra={
            editing === null
              ? 'Ровно 5 латинских букв или цифр'
              : 'Код не правится: он печатается в номерах актов и в именах выгрузок. Опечатка исправляется отключением объекта и заведением нового.'
          }
        >
          <Input maxLength={5} disabled={editing !== null} data-testid="object-code" />
        </Form.Item>
        <Form.Item
          name="name"
          label="Наименование"
          rules={[{ required: true, message: 'Наименование обязательно' }]}
        >
          <Input maxLength={255} data-testid="object-name" />
        </Form.Item>
        <Form.Item
          name="fullName"
          label="Полное наименование"
          rules={[{ required: true, message: 'Полное наименование обязательно' }]}
          extra="Как в разрешении на строительство: печатается в шапке реестра"
        >
          <Input maxLength={1000} data-testid="object-full-name" />
        </Form.Item>
        <Form.Item name="address" label="Адрес">
          <Input maxLength={1000} />
        </Form.Item>
        <Form.Item name="cadastralNumber" label="Кадастровый номер">
          <Input maxLength={255} />
        </Form.Item>
        <Form.Item name="permitIdentifier" label="Идентификатор ОКС">
          <Input maxLength={255} placeholder="90-128/КЛ-23" />
        </Form.Item>
        <Form.Item
          name="actNumberPattern"
          label="Шаблон номера акта"
          extra="Сверяется правилом AOSR.ACT"
        >
          <Input maxLength={255} />
        </Form.Item>

        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          Участники строительства печатаются в шапке реестра и сверяются правилами.
        </Typography.Paragraph>
        <Form.Item name="developerId" label="Застройщик">
          <Select allowClear showSearch optionFilterProp="label" options={partyOptions} />
        </Form.Item>
        <Form.Item name="techCustomerId" label="Технический заказчик">
          <Select allowClear showSearch optionFilterProp="label" options={partyOptions} />
        </Form.Item>
        <Form.Item name="generalContractorId" label="Генеральный подрядчик">
          <Select allowClear showSearch optionFilterProp="label" options={partyOptions} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
