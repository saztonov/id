/**
 * Состав комплекта и результат проверки по каждой позиции (S29).
 *
 * ## Зачем таблица появилась
 *
 * ADR-0016 свёл вкладку к списку ошибок — и это было верно ровно до первого
 * чистого комплекта. Заказчик прошёл стенд на 83 страницах и сказал прямо:
 * «результат распознавания невозможно понять». Экран, отвечающий только на
 * вопрос «что не так», при отсутствии ошибок показывает пустую таблицу, по
 * которой нельзя понять даже, прочитал ли портал хоть что-нибудь.
 *
 * Порядок разделов назвал заказчик: **акт → строки внутреннего реестра →
 * паспорта, сертификаты и прочее**, с подтверждением в каждой строке.
 *
 * ## Это НЕ возврат раздела «Документы комплекта»
 *
 * ADR-0016 убрал не показ состава, а требование СОБИРАТЬ его руками. Здесь нет
 * ни одной кнопки, меняющей состав: границы документов подтверждает конвейер,
 * нарезка идёт сама, и просить пользователя что-либо подтверждать таблица не
 * начинает.
 *
 * ## Всё готовым приходит с сервера
 *
 * Заголовок строки, номер страницы, состояние сверки с реестром и вердикты
 * правил живут только в БД (ADR-0016, решение 2). Клиент печатает пришедшее и
 * не пересортировывает: вторая сортировка либо повторила бы серверную, либо
 * разошлась бы с ней.
 *
 * ## Контракт `data-testid`
 *
 * `checks-report` · `checks-report-section-{kind}` · `checks-report-row-{id}`
 */
import type { ReactNode } from 'react';
import { Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import type { CheckReport, ReportRow, ReportSection } from '../../api/types.js';
import { Link } from '../../app/router.js';
import { ToneTag } from '../../shared/tags.js';
import {
  datesLabel,
  itemLabel,
  markOf,
  pagesLabel,
  rowDetailText,
  rowHref,
  rowTagText,
  sectionTally,
  toneOf,
} from './report.js';

export function ReportTable({
  revisionId,
  report,
}: {
  revisionId: string;
  report: CheckReport;
}): ReactNode {
  if (report.sections.length === 0) {
    return (
      <Typography.Paragraph type="secondary" data-testid="checks-report">
        Портал ещё не разобрал комплект на документы: состав появится после распознавания.
      </Typography.Paragraph>
    );
  }

  return (
    <div data-testid="checks-report">
      {report.sections.map((section) => (
        <SectionBlock key={section.kind} revisionId={revisionId} section={section} />
      ))}
    </div>
  );
}

function SectionBlock({
  revisionId,
  section,
}: {
  revisionId: string;
  section: ReportSection;
}): ReactNode {
  const tally = sectionTally(section);

  return (
    <div data-testid={`checks-report-section-${section.kind}`} style={{ marginBottom: 24 }}>
      <Space align="baseline" wrap style={{ marginBottom: 4 }}>
        <Typography.Title level={3} style={{ fontSize: 16, margin: 0 }}>
          {section.title}
        </Typography.Title>
        {tally !== null && <Typography.Text type="secondary">{tally}</Typography.Text>}
      </Space>

      {/*
        Заявление о секции целиком — «реестр приложений в комплекте не найден».
        Это не замечание: подрядчику нечего с ним сделать кнопкой, но пустая
        секция без объяснения неотличима от сломанного экрана.
      */}
      {section.note !== null && (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          {section.note}
        </Typography.Paragraph>
      )}

      {section.rows.length > 0 && (
        <Table<ReportRow>
          rowKey="id"
          size="middle"
          pagination={false}
          dataSource={section.rows}
          /*
            Ширины столбцов обязаны быть ЗАКОНОМ, а не пожеланием.

            При раскладке `auto` (умолчание antd) браузер раздаёт ширину по
            содержимому, и таблица с длинным замечанием сжимала «Позицию
            комплекта» до одной буквы в строке, а соседняя таблица на той же
            странице раскладывалась совсем иначе. Разная разметка у таблиц
            одного экрана читается как разные сущности, хотя это один и тот же
            список в четырёх разрезах.
          */
          tableLayout="fixed"
          expandable={{
            // Раскрытие только там, где есть что раскрыть: пустая стрелка у
            // каждой строки обещает подробности, которых нет.
            rowExpandable: (row) => row.items.length > 0,
            expandedRowRender: (row) => <ItemList row={row} />,
            // Место под стрелку резервируется всегда: без этого таблица с
            // раскрытием и таблица без него разъезжаются по всем колонкам.
            columnWidth: 48,
          }}
          columns={reportColumns(revisionId)}
        />
      )}
    </div>
  );
}

/**
 * Столбцы, ОДНИ на все разделы отчёта.
 *
 * Объявлены один раз и переиспользуются каждой секцией: пока определения
 * лежали внутри `map`, ничто не мешало им разъехаться, и разъезжались они уже
 * при раскладке `auto`. Ширины — в процентах, чтобы таблица дышала вместе с
 * окном; «Стр.» в пикселях, потому что номер страницы шире не становится.
 */
function reportColumns(revisionId: string): ColumnsType<ReportRow> {
  return [
    {
      title: 'Стр.',
      key: 'pages',
      width: 72,
      render: (_value, row) => <PagesCell revisionId={revisionId} row={row} />,
    },
    {
      title: 'Позиция комплекта',
      key: 'title',
      width: '34%',
      render: (_value, row) => (
        /*
          Метка на содержимом ячейки, а не через `onRow`: прокидывает ли antd
          произвольные `data-*` до узла строки — её внутреннее дело, и
          завязывать на это контракт прогонов значит получить отказ сценария на
          обновлении библиотеки, а не на изменении портала (тот же довод, что
          был у таблицы замечаний).
        */
        <Space direction="vertical" size={0} data-testid={`checks-report-row-${row.id}`}>
          <Typography.Text>{row.title}</Typography.Text>
          {row.subtitle !== null && (
            <Typography.Text type="secondary">{row.subtitle}</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Даты',
      key: 'dates',
      width: '18%',
      render: (_value, row) => {
        const dates = datesLabel(row);
        return dates === null ? null : <Typography.Text>{dates}</Typography.Text>;
      },
    },
    {
      title: 'Результат',
      key: 'status',
      render: (_value, row) => {
        const detail = rowDetailText(row);
        return (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            {/*
              На метке — короткое слово, под ней — подробности обычным текстом.
              Метка не переносится по словам и, приняв в себя всё замечание,
              продавливала ширину соседних колонок.
            */}
            <ToneTag tone={toneOf(row.status)}>
              {markOf(row.status)} {rowTagText(row)}
            </ToneTag>
            {detail !== null && <Typography.Text>{detail}</Typography.Text>}
            {/*
              Способ устранения — сразу, а не в раскрытии строки: замечание без
              него бесполезно подрядчику (§9.1), а раскрытие — ещё одно нажатие
              ради двух строк текста.
            */}
            {row.statusHint !== null && (
              <Typography.Text type="secondary">{row.statusHint}</Typography.Text>
            )}
          </Space>
        );
      },
    },
  ];
}

/**
 * Пункты чек-листа акта либо замечания документа.
 *
 * Троичность §0.5 остаётся видимой: «неприменимо» и «не исполнялось» стоят
 * своими словами рядом с пройденным, а не прячутся и не сливаются с ним.
 * Спрятать их значило бы объявить чек-лист полным там, где часть правил вообще
 * не работала.
 */
function ItemList({ row }: { row: ReportRow }): ReactNode {
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {row.items.map((item) => (
        <Space key={item.code} size={8} align="start" wrap>
          <ToneTag tone={toneOf(item.status)}>
            {markOf(item.status)} {itemLabel(item.status)}
          </ToneTag>
          <Typography.Text>{item.title}</Typography.Text>
          {item.detail !== null && (
            <Typography.Text type="secondary">— {item.detail}</Typography.Text>
          )}
          {item.hint !== null && <Typography.Text type="secondary">{item.hint}</Typography.Text>}
          {/* Код правила нужен поддержке и не стоит ширины колонки. */}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.code}
          </Typography.Text>
        </Space>
      ))}
    </Space>
  );
}

/**
 * Номер страницы со ссылкой на разметку.
 *
 * Когда рабочий документ не собран, ссылки нет вовсе: неработающая ссылка хуже
 * её отсутствия, потому что по ней нажмут.
 */
function PagesCell({ revisionId, row }: { revisionId: string; row: ReportRow }): ReactNode {
  const label = pagesLabel(row);
  if (label === null) return null;
  const href = rowHref(revisionId, row);
  if (href === null) return <Typography.Text>{label}</Typography.Text>;

  const link = <Link to={href}>{label}</Link>;
  // Метка по коду правила сохраняет прежний контракт прогонов: §16 проверяет
  // переход «замечание → доказательство» именно по нему, и у строк без
  // замечания её нет вовсе — там и переходить не к чему.
  return row.statusRuleCode === null ? (
    link
  ) : (
    <span data-testid={`evidence-${row.statusRuleCode}`}>{link}</span>
  );
}
