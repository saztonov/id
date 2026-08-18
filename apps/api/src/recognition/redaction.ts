/**
 * Обезвреживание подписанных ссылок RD WEB (§11, ADR-0005 п. 9).
 *
 * ## Что именно здесь секрет
 *
 * `export_crop_short_url` выдаёт БЕССРОЧНУЮ подписанную ссылку на кроп блока, а
 * отдача кропа у них публичная (`api/routes/crops.py` — роут без зависимости
 * аутентификации). Значит такая ссылка — это bearer-возможность: попав в историю
 * браузера, в пересланный файл или в лог прокси, она даёт чтение изображения
 * фрагмента чужой исполнительной документации в обход их RBAC и без срока
 * давности. §11 прямо относит подписанный URL к значениям, подлежащим redaction,
 * и §4.2 по той же причине запрещает отдавать наружу presigned GET.
 *
 * ## Где она приезжает
 *
 * Во всех трёх записях архива экспорта: в `document.md` строкой
 * `> **Crop:** [Crop](<url>)` (`finalizer/render_markdown.py`), в
 * `document.html` блоком `<div class="block-crop">…<a href="…">`
 * (`finalizer/render_html.py`) и — по открытой схеме `QaManifest`
 * (`extra="allow"`, свободный `checks: dict`) — потенциально в
 * `qa_manifest.json`.
 *
 * ## Почему правил три, а результат один
 *
 * Markdown, HTML и JSON — разные носители, и «вырезать строку провенанса»
 * осмысленно только в первом. Поэтому у каждого вида своё правило, но общий
 * рубеж один и тот же и стоит последним: любая уцелевшая абсолютная ссылка
 * обезвреживается независимо от того, откуда она взялась. Порядок именно такой —
 * специальное правило убирает СМЫСЛ строки провенанса, общее закрывает всё
 * остальное, включая формы, которых их рендер сегодня не производит.
 *
 * Хранение при этом НЕ санируется: архив лежит побайтово, иначе
 * `artifact_sha256` перестал бы описывать полученное (ADR-0005 п. 4 и 8).
 * Санируется ВЫДАЧА — то есть ровно тот путь, на котором ссылка покидает портал.
 */

/** Строки провенанса их рендера. `> status:` — диагностика блока, она остаётся. */
export const PROVENANCE_LINE = /^> \*\*(Created|Crop|Stamp):\*\*/;

/**
 * Абсолютная ссылка любой формы.
 *
 * Граница множества символов взята по разделителям всех трёх носителей сразу:
 * пробел и перевод строки (markdown), кавычки и угловые скобки (html и json),
 * закрывающая круглая скобка (markdown-ссылка `](url)`).
 */
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

/** Чем заменяется вырезанная ссылка: видимая отметка, а не пустая строка. */
export const REDACTED_URL = '(ссылка удалена)';

export interface Redacted {
  readonly text: string;
  /** Сколько значений обезврежено: ноль на непустом экспорте подозрителен. */
  readonly count: number;
}

/** Общий последний рубеж: абсолютных ссылок в результате не остаётся. */
export function redactAbsoluteUrls(text: string): Redacted {
  let count = 0;
  const result = text.replace(ABSOLUTE_URL, () => {
    count += 1;
    return REDACTED_URL;
  });
  return { text: result, count };
}

/**
 * Markdown: строки провенанса выбрасываются целиком.
 *
 * То же правило, что применяется к `page_text_versions.text_md` при разборе
 * экспорта, — и это не совпадение, а требование: артефакт `md`, отданный
 * наружу, не имеет права содержать того, что вырезано из текста страницы.
 */
export function redactMarkdown(markdown: string): Redacted {
  let count = 0;
  const kept: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (PROVENANCE_LINE.test(line)) {
      count += 1;
      continue;
    }
    const scrubbed = redactAbsoluteUrls(line);
    count += scrubbed.count;
    kept.push(scrubbed.text);
  }
  return { text: kept.join('\n'), count };
}

/**
 * HTML: вырезается весь бокс ссылки на кроп, а не только её значение.
 *
 * Оставленный `<a href="(ссылка удалена)">Crop</a>` был бы честен, но
 * бессмысленен, а главное — он приглашает читателя искать «настоящую» ссылку.
 * Общий рубеж всё равно проходит следом: разметка их рендера может измениться, и
 * правило не имеет права держаться на совпадении имени CSS-класса.
 */
export function redactHtml(html: string): Redacted {
  let count = 0;
  const withoutCropBox = html.replace(/<div class="block-crop">[\s\S]*?<\/div>/gi, () => {
    count += 1;
    return `<div class="block-crop"><b>Crop:</b> ${REDACTED_URL}</div>`;
  });
  const scrubbed = redactAbsoluteUrls(withoutCropBox);
  return { text: scrubbed.text, count: count + scrubbed.count };
}

/**
 * JSON: обход дерева, а не текстовая замена по всему файлу.
 *
 * Текстовая замена по сырым байтам испортила бы экранирование и могла бы выдать
 * невалидный JSON — а получатель обязан иметь возможность разобрать манифест.
 * Разбор с последующей сериализацией гарантирует и валидность, и то, что ссылка
 * обезврежена в ЛЮБОМ поле, включая те, которых сегодня в их схеме нет
 * (`QaManifest` объявлен с `extra="allow"`).
 *
 * Неразбираемый JSON не пропускается «как есть»: применяется текстовое правило.
 * Иначе достаточно было бы прислать битый манифест, чтобы ссылка вышла наружу.
 */
export function redactJson(json: string): Redacted {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return redactAbsoluteUrls(json);
  }

  let count = 0;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const scrubbed = redactAbsoluteUrls(value);
      count += scrubbed.count;
      return scrubbed.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => {
          // Ключ объекта — тоже строка, и ссылка может стоять именно в нём.
          const scrubbedKey = redactAbsoluteUrls(key);
          count += scrubbedKey.count;
          return [scrubbedKey.text, walk(item)];
        }),
      );
    }
    return value;
  };

  const result = walk(parsed);
  return { text: JSON.stringify(result, null, 2), count };
}

/**
 * Виды артефактов, которые отдаются наружу САНИРОВАННЫМИ.
 *
 * `zip` в перечне отсутствует намеренно: архив — это доказательство целиком, и
 * менять его байты при выдаче значило бы отдавать нечто, чему записанный
 * `artifact_sha256` не соответствует. Поэтому архив не санируется, а
 * закрывается правом (см. маршрут выдачи содержимого).
 */
export const REDACTABLE_ARTIFACT_KINDS = ['md', 'html', 'qa', 'blocks_json'] as const;

export type RedactableArtifactKind = (typeof REDACTABLE_ARTIFACT_KINDS)[number];

export function isRedactableArtifactKind(kind: string): kind is RedactableArtifactKind {
  return (REDACTABLE_ARTIFACT_KINDS as readonly string[]).includes(kind);
}

export interface RedactedArtifact {
  readonly bytes: Buffer;
  readonly count: number;
}

/**
 * Санация содержимого производного артефакта перед выдачей наружу.
 *
 * Вид выбирает правило, но НЕ выбирает, применять ли санацию вообще: каждый
 * производный вид проходит через неё, потому что перечисление «этот вид ссылку
 * не несёт» — ровно тот способ рассуждения, из-за которого утечка через `html`
 * и `qa` и осталась незамеченной.
 */
export function redactArtifactContent(
  kind: RedactableArtifactKind,
  bytes: Buffer,
): RedactedArtifact {
  const source = bytes.toString('utf8');
  const result =
    kind === 'md'
      ? redactMarkdown(source)
      : kind === 'html'
        ? redactHtml(source)
        : redactJson(source);
  return { bytes: Buffer.from(result.text, 'utf8'), count: result.count };
}
