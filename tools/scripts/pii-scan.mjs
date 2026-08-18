/**
 * Барьер против попадания персональных данных корпуса в репозиторий.
 *
 * Правило §1.4 плана: реальные документы в git не попадают, в тестах живут
 * только синтетические данные. Правило нарушалось на практике — агенты,
 * писавшие тесты по образцам, переносили в них настоящие ФИО подписантов
 * и hex-отпечатки сертификатов ЭП. Разовая вычитка такое не удержит,
 * поэтому проверка автоматическая и входит в гейт.
 *
 * ## Почему здесь хэши, а не значения
 *
 * До этой ревизии сканер хранил маркеры открытым текстом: двенадцать настоящих
 * фамилий подписантов и шесть отпечатков сертификатов ЭП лежали прямо в этом
 * отслеживаемом git файле. То есть страж ПДн сам был их носителем и сам нарушал
 * §1.4 — причём в самом неудобном месте, потому что удалить его нельзя, а
 * исключение `SELF` делало нарушение невидимым для проверки.
 *
 * Так вышло не по недосмотру: обезличиватель корпуса читал этот файл как
 * СПРАВОЧНИК значений (`readPiiScanMarkers`), и открытый текст был условием его
 * работы. Зависимость разведена: значения обезличивателю даёт закрытый корпус
 * (`GOLDEN_CORPUS_DIR`, вне git), а сканеру знать их не нужно — ему достаточно
 * уметь их УЗНАТЬ.
 *
 * Поэтому здесь лежат только солёные хэши. Сканирование идёт не подстрокой, а
 * по кандидатам: из текста файла регэкспами вырезаются все фрагменты, которыми
 * маркер В ПРИНЦИПЕ может быть (цепочки цифр длиной 10/12/13/15, hex-строки
 * длиной 32–33, кириллические подстроки длиной 4–16), каждый нормализуется
 * (NFKC + lower), хэшируется и ищется в множестве.
 *
 * Точность при этом не теряется, а растёт. Любое вхождение маркера в текст
 * лежит внутри соответствующей цепочки, и все её подстроки нужной длины
 * перебираются — значит всё, что ловилось `text.includes(marker)`, ловится и
 * сейчас. Сверх того ловятся варианты в другом регистре и в другом падеже,
 * которые прежняя посимвольная проверка пропускала.
 *
 * ## Соль и стойкость
 *
 * Соль — константа в этом же файле, то есть публична. Она не «пароль», а
 * разделитель областей: без неё хэш ИНН совпал бы с хэшем того же ИНН в любом
 * чужом словаре, и утечка одного проекта раскрывала бы другой.
 *
 * От перебора защищает не соль, а стоимость хэша, и она разная по классам:
 *
 * - **Короткие числовые маркеры (ИНН, ОГРН) — scrypt, N=2^15, r=8, p=1.**
 *   Пространство 10-значного ИНН — 10^10, и на быстром sha256 оно перебирается
 *   за часы. Медленный KDF поднимает цену перебора примерно в миллион раз, до
 *   десятков тысяч лет односоставного перебора. `maxmem` поднят явно: параметры
 *   требуют 32 МиБ на вызов, а Node по умолчанию отводит 32 МиБ на всё и
 *   бросает `ERR_CRYPTO_INVALID_SCRYPT_PARAM`.
 * - **Длинные маркеры (отпечатки сертификатов, фамилии) — обычный sha256.**
 *   Отпечаток — 32–33 шестнадцатеричных символа, это 2^128 вариантов: перебор
 *   нереалистичен независимо от скорости хэша. Фамилия перебирается по словарю,
 *   но словарь фамилий — не персональные данные; раскрывает не сам факт «эта
 *   фамилия существует», а привязка к корпусу, а её из хэша не достать без
 *   того же словаря, который у обладателя корпуса и так есть. Платить за это
 *   KDF-ом было бы дорого: кириллических подстрок-кандидатов в дереве около
 *   140 тысяч против нескольких сотен числовых.
 *
 * ## Время прогона
 *
 * Замерено на дереве из 331 файла (около 4,7 МБ текста): уникальных числовых
 * кандидатов — 421, кириллических подстрок — около 139 тысяч, hex — около 850.
 * Полный прогон — 24–25 секунд, из них почти всё scrypt. Держится это на двух
 * вещах, без которых прогон встаёт на минуты: кандидаты дедуплицируются по
 * ВСЕМУ дереву разом, а результат KDF кэшируется по нормализованному значению.
 * Вызовы scrypt асинхронные и идут параллельно на пуле libuv (см.
 * `UV_THREADPOOL_SIZE` ниже). Без параллелизма те же 421 кандидатов дают около
 * 70 секунд, без дедупликации — минуты.
 *
 * Полминуты для гейта приемлемы, а понижать N ради секунд смысла нет: цена
 * прогона линейна по числу кандидатов, а цена перебора — по всему пространству
 * значений, и терять там миллион ради двадцати секунд здесь невыгодно.
 *
 * ## Наименования организаций остались открытым списком
 *
 * `ORGS` — единственный класс маркеров, который здесь лежит как есть, и это
 * осознанное решение, а не недоделка.
 *
 * Во-первых, это не персональные данные: наименование юрлица — сведение из
 * ЕГРЮЛ, открытого реестра, и §1.4 запрещает его в коде не потому, что это
 * ПДн, а потому, что оно идентифицирует объект строительства. Фамилия
 * подписанта — другая категория, и прятать её обязательно.
 *
 * Во-вторых, спрятать их без потери точности нечем. Наименования многословны и
 * со знаками («СТАДИОН "СПАРТАК"»), под класс «слово кириллицей» не подпадают,
 * а кандидатами пришлось бы делать произвольные n-граммы текста — это либо
 * комбинаторный взрыв, либо угадывание границ, то есть потеря срабатываний.
 * Молча ослабить барьер ради красоты хуже, чем оставить в файле шесть
 * публичных наименований.
 *
 * ## Fail-closed против усыхания списка
 *
 * Пустое множество маркеров даёт «чисто» на любом дереве, поэтому рядом с
 * хэшами закоммичены ожидаемое число маркеров каждого класса и отпечаток всего
 * множества (`MARKER_SET_EXPECTED`). Расхождение — отказ, а не «чисто».
 *
 * Второй рубеж — само-проверка (`selfTest`). В множество добавлен СИНТЕТИЧЕСКИЙ
 * маркер каждого класса: выдуманная фамилия, номер из зарезервированного
 * диапазона и заведомо ненастоящий отпечаток. Их в корпусе нет, зато сканер
 * обязан краснеть на них в памяти при каждом запуске. Без этого протухший
 * детектор — сломанный регэксп, испорченная нормализация — выглядел бы ровно
 * как чистое дерево.
 */
/* global console -- eslint не знает глобалей Node для .mjs вне пакетов воркспейса */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, scrypt } from 'node:crypto';
import { argv, env, exit, hrtime } from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Пул libuv по умолчанию — четыре потока, а вызовов scrypt сотни.
 *
 * Размер пула читается один раз, при первой асинхронной операции, поэтому
 * переменную приходится ставить до всего остального. Существующее значение не
 * перетирается: если его задали снаружи, значит так и хотели.
 */
env['UV_THREADPOOL_SIZE'] ??= '8';

/** Разделитель областей хэширования; публична, паролем не является. */
const SALT = 'id-portal/pii-scan/v1';

/** Параметры KDF для коротких числовых маркеров. */
const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });

/**
 * Множество маркеров: хэши, а не значения.
 *
 * `surname` и `cert` — sha256(SALT ‖ NFKC(lower(значение))), `id` — scrypt от
 * того же нормализованного значения с той же солью. Порядок внутри классов —
 * лексикографический по хэшу: он ничего не сообщает о порядке исходного
 * списка, где значения были сгруппированы по смыслу.
 *
 * В каждом классе ровно один хэш принадлежит синтетической фикстуре
 * `SELF_TEST_TEXT`, остальные — закрытому корпусу.
 */
export const MARKER_SET = Object.freeze({
  /** Фамилии подписантов и заверителей. */
  surname: Object.freeze([
    '01eee5e0ed3726fd90b57873f01d797bbd88671f4ca906a54203317cc6e567f8',
    '22dc40035856effc9d74be6034873cdee65ed1eeea2a7e22fa645df091fb5298',
    '28a5c58a760926bf5d9ce8eff42542ac95f8be4cef9f35f1d90bff174370055f',
    '3991138d67b28fcf19b131824b8d397c09718e85ca295b150f8af9c1ef21c137',
    '40a3be481b4aacc58e549b6d03aa5840c564795aae512e5cb3137597e7918f5a',
    '49d7ba2fa98bc71c4c814afc27c537f1ff20cdd720d41db2334730e5b0ac7c6c',
    '4bff19af3f964e696832f182b7ef1156410c71da6673e77dac169a6d693992bf',
    '6ca0ec0bfa63e785b08b3580174a0d9d9af190f00c51ff5f18b2d4a587b93796',
    '6ef3646e9bb704212c5c84e9e068ba4e5e8c5356acab7efa8b54f3934fcb3024',
    '868718599c3026432b01f656aeda1535d3cc3f4d87d0ae6980a38023f690f5a7',
    'a96969fad97051f429eb95c2723d4c7e708179b3985e3fe992b1531ef7990e8f',
    'ba4bd8d2632fb0871dee317b876df3157b9367538a433e6143e9290145e72fae',
    'eee2135f021f67df4bc55ffa520ec7b5e8c277271a327bd3c51598ba68fe8441',
  ]),
  /** Отпечатки сертификатов электронной подписи. */
  cert: Object.freeze([
    '2886f4763cffa10ffb775e125b40fb278e246cb12338a197055f60b81a32e284',
    '54e3b78dba0017625aae49d6aa4748b59ca704bb264f21b96837b4d8911d6d33',
    '95dc2bdc69eeb1ae533c5514ab2763c8fdabbe84f76ff9bf61eb0b48d0f399cf',
    '960939ac1c17d6bc5618712cf9ee296a98fdb09c470c1b46315b8b39dcb3881d',
    '9ee46b5a91666cc88559e433da445508e5a745422cd867122b1207985a217d56',
    'c0dbc18c043dd21831efb0087306e08dd6921545e8e927676dd972b2f99d01fb',
    'e1cc6972e225e734860bacc0c572deb45bcc10423b502075c998d58747d71197',
  ]),
  /**
   * ИНН и ОГРН участников.
   *
   * Их десять и семь: `docs/CORPUS_FINDINGS.md` перечисляет десять проверенных
   * ИНН, а прежняя версия этого файла знала шесть из них. Четыре настоящих ИНН
   * корпуса барьер попросту не ловил — файл с таким ИНН давал «чисто».
   */
  id: Object.freeze([
    '06622c815f7c505d6deb6993669de77c2952e8e2960d5ef032af48fcf6e7ad7d',
    '1ba16788e35b1ac22d4adeeb3b7907069882793e560dcacb4cef804ff80549dd',
    '38a63c14b0e9704da9d0964c4c4ed27cf92724505da428fef28a0df4c7fb71ed',
    '5a63931f2d6cdba787f3e036aadacb47383b2e08c3ef33b0b93b9becdb598548',
    '5d37bda995f9591a2b327efe7f5c1a0696239371beee3a1fd6059c2f804a1506',
    '5ea5f9038f42ebdc1f1e4b9f9042b17cdb8a533e51edeb4314ecf4b454198806',
    '71aa5ebdd2a4839d3a191f8d39fbcdea89abd97037e11d2a4274107528dfd13c',
    '78a5a0b7bb158d394ff32ab5fdbc51142f7aaf25719bb25e7f5d83304eccc09d',
    '94f31b4b48a3b74b0afe76b179acf3b5c13f86c5bce07e8a0aeff4f883f3c827',
    '9e187b422130e807a3b6d94107c53062e048ffb76e13f20c9f9a7f7e8106b5d9',
    'a64ebf3a955fe91a19c919a18b68d60c454b7c8e0810e9cc59d9719d76398a8d',
    'ac43ac19c1d8993d0e41b234cbd884647e766ca20c796c8d34c26219048a8a39',
    'b4738bc3b733028ff725794a1a707deb2ccc0df2ee546b4167df47001b233241',
    'c43096350e7a60694ca8467129e7073b4a3629c4ea0615b49cd91d242f3f1e9d',
    'c7c5ae5dc35c9eea95978e5a5a32335974602c7cf355f5d3bdef0a1a6dc5c0d4',
    'e127318ec8eb992b558f10c2e87113bf13f812872373a8dbcb679b997ceaca08',
    'ed7fadb284c5567d79019baffd6fa8294ef549b540d8b4c7dcf418a9ef30dda2',
    'ed9770ddfa2b3b118ae7a0aab5ced50df487611a75493a90112e67be5ec37a3f',
  ]),
  /** Наименования организаций: открытый список, обоснование — в шапке файла. */
  org: Object.freeze([
    'СУ-10',
    'ЭМДМ',
    'МС-90',
    'СТАДИОН "СПАРТАК"',
    'СТАДИОН «СПАРТАК»',
    'Primavera',
  ]),
});

/**
 * Ожидаемая форма множества: число маркеров по классам и общий отпечаток.
 *
 * Число ловит удаление и добавление, отпечаток — подмену: если хэш заменить
 * другим хэшем, счётчик сойдётся, а отпечаток нет.
 */
export const MARKER_SET_EXPECTED = Object.freeze({
  counts: Object.freeze({ surname: 13, cert: 7, id: 18, org: 6 }),
  digest: '90dc6b3870bce34c4f23ae9ca9ab01930f973fa5576f241c9ab0a60848640424',
});

/**
 * Документация, где допустимы реквизиты юрлиц из открытого реестра.
 *
 * Классы различаются по строгости, потому что различаются по природе. ФИО
 * подписантов и отпечатки их сертификатов (`surname`, `cert`) — персональные
 * данные, им не место нигде. Наименования организаций, ИНН и ОГРН (`org`,
 * `id`) — сведения из ЕГРЮЛ, открытого реестра; в коде и тестах они не нужны,
 * но в документации проверенных фактов необходимы: без конкретного ОГРН вывод
 * о битой контрольной сумме нельзя перепроверить. Для перечисленных здесь
 * файлов проверяется только строгий класс — см. `includeCodeOnly`.
 */
const DOCS_ALLOWED = /^docs\/(CORPUS_FINDINGS|EXECUTION_LOG)\.md$/;

/** Сам сканер содержит синтетическую фикстуру и открытый список наименований. */
const SELF = /^tools\/scripts\/pii-scan\.mjs$/;

/** Двоичные форматы, в которых искать подстроки бессмысленно. */
const BINARY = /\.(pdf|png|jpg|jpeg|webp|ico|woff2?)$/i;

// ---------------------------------------------------------------------------
// Нормализация и хэширование
// ---------------------------------------------------------------------------

/**
 * Приводит кандидата к канонической форме перед хэшированием.
 *
 * NFKC складывает совместимые начертания (полноширинные цифры, лигатуры),
 * lower снимает регистр. Обе операции обязаны применяться и к маркеру, и к
 * кандидату — иначе хэши не встретятся.
 */
export function normalizeMarker(value) {
  return value.normalize('NFKC').toLowerCase();
}

/** Кэш быстрых хэшей: одни и те же подстроки встречаются десятки тысяч раз. */
const fastCache = new Map();

/** sha256(SALT ‖ нормализованное значение) для длинных маркеров. */
export function fastHash(normalized) {
  const cached = fastCache.get(normalized);
  if (cached !== undefined) return cached;
  const digest = createHash('sha256').update(`${SALT}${normalized}`, 'utf8').digest('hex');
  fastCache.set(normalized, digest);
  return digest;
}

/**
 * Кэш медленных хэшей.
 *
 * Хранится ОБЕЩАНИЕ, а не результат: одно и то же значение встречается в
 * нескольких файлах, и без кэша обещаний параллельные обращения запустили бы
 * scrypt повторно ещё до того, как первый успел завершиться.
 */
const slowCache = new Map();

/** scrypt(нормализованное значение, SALT) для коротких числовых маркеров. */
export function slowHash(normalized) {
  const cached = slowCache.get(normalized);
  if (cached !== undefined) return cached;
  const pending = new Promise((resolve, reject) => {
    scrypt(normalized, SALT, 32, SCRYPT_PARAMS, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString('hex'));
    });
  });
  slowCache.set(normalized, pending);
  return pending;
}

/**
 * Отпечаток всего множества: sha256 от отсортированной конкатенации.
 *
 * Наименования организаций участвуют своим нормализованным значением — они и
 * так открыты, а исключить их значило бы оставить класс без защиты от усыхания.
 */
export function markerSetDigest(set) {
  const lines = [];
  for (const cls of ['surname', 'cert', 'id']) {
    for (const hash of set[cls]) lines.push(`${cls}\t${hash}`);
  }
  for (const org of set.org) lines.push(`org\t${normalizeMarker(org)}`);
  lines.sort();
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * Fail-closed: множество маркеров обязано совпасть с закоммиченной формой.
 *
 * Бросает исключение, а не возвращает `false`: молча продолжать с усохшим
 * списком — ровно тот отказ, от которого эта функция и защищает.
 */
export function verifyMarkerSet(set = MARKER_SET, expected = MARKER_SET_EXPECTED) {
  const problems = [];
  for (const [cls, count] of Object.entries(expected.counts)) {
    const actual = set[cls]?.length ?? 0;
    if (actual !== count) problems.push(`класс «${cls}»: маркеров ${actual}, ожидалось ${count}`);
  }
  const digest = markerSetDigest(set);
  if (digest !== expected.digest) {
    problems.push(`отпечаток множества ${digest}, ожидался ${expected.digest}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `Множество маркеров ПДн повреждено:\n  ${problems.join('\n  ')}\n` +
        'Сканирование не выполнено: пустой или урезанный список даёт «чисто» на любом дереве.\n' +
        'Если множество меняли осознанно — пересчитайте counts и digest в MARKER_SET_EXPECTED.',
    );
  }
}

// ---------------------------------------------------------------------------
// Кандидаты
// ---------------------------------------------------------------------------

/** Длины числовых маркеров: ИНН 10 и 12, ОГРН 13, ОГРНИП 15. */
const ID_LENGTHS = Object.freeze([10, 12, 13, 15]);

/** Длины отпечатков сертификатов в наблюдаемых написаниях. */
const CERT_LENGTHS = Object.freeze([32, 33]);

/** Границы длины фамилии: короче четырёх букв фамилий не бывает. */
const SURNAME_MIN = 4;
const SURNAME_MAX = 16;

const DIGIT_RUN = /\d+/g;
const HEX_RUN = /[0-9a-fA-F]+/g;
const CYRILLIC_RUN = /[Ѐ-ӿ]+/g;

/** Добавляет в множество все подстроки заданных длин. */
function addWindows(run, lengths, into) {
  for (const length of lengths) {
    for (let i = 0; i + length <= run.length; i += 1) into.add(run.slice(i, i + length));
  }
}

/**
 * Вырезает из текста всё, чем маркер в принципе может быть.
 *
 * Берутся именно ПОДСТРОКИ цепочек, а не цепочки целиком: маркер может стоять
 * вплотную к другим цифрам или буквам («ИНН1234567890/КПП»), и проверка по
 * цепочке целиком такое вхождение потеряла бы. Подстроки дают ту же полноту,
 * что и прежний `text.includes(marker)`.
 */
export function collectCandidates(text) {
  const surname = new Set();
  const cert = new Set();
  const id = new Set();
  for (const match of text.matchAll(DIGIT_RUN)) addWindows(match[0], ID_LENGTHS, id);
  for (const match of text.matchAll(HEX_RUN)) {
    if (match[0].length >= CERT_LENGTHS[0]) {
      addWindows(normalizeMarker(match[0]), CERT_LENGTHS, cert);
    }
  }
  for (const match of text.matchAll(CYRILLIC_RUN)) {
    const run = normalizeMarker(match[0]);
    for (let length = SURNAME_MIN; length <= SURNAME_MAX; length += 1) {
      for (let i = 0; i + length <= run.length; i += 1) surname.add(run.slice(i, i + length));
    }
  }
  return { surname, cert, id };
}

// ---------------------------------------------------------------------------
// Сканирование
// ---------------------------------------------------------------------------

/** Индексы множеств: строить `Set` на каждый файл дороже самого поиска. */
const indexCache = new WeakMap();

function indexOf(set) {
  const cached = indexCache.get(set);
  if (cached !== undefined) return cached;
  const index = {
    surname: new Set(set.surname),
    cert: new Set(set.cert),
    id: new Set(set.id),
  };
  indexCache.set(set, index);
  return index;
}

/**
 * Ищет маркеры в тексте и возвращает найденное.
 *
 * `includeCodeOnly: false` оставляет только строгий класс — так проверяется
 * документация, которой реквизиты юрлиц разрешены. Возвращаемое `value` —
 * фрагмент САМОГО проверяемого текста, а не маркер из множества: сообщить
 * разработчику, что именно нашлось, можно только тем, что уже лежит у него в
 * файле.
 */
export async function scanText(text, options = {}) {
  const { set = MARKER_SET, includeCodeOnly = true } = options;
  const index = indexOf(set);
  const candidates = collectCandidates(text);
  const hits = [];
  for (const value of candidates.surname) {
    if (index.surname.has(fastHash(value))) hits.push({ class: 'surname', value });
  }
  for (const value of candidates.cert) {
    if (index.cert.has(fastHash(value))) hits.push({ class: 'cert', value });
  }
  if (includeCodeOnly) {
    const values = [...candidates.id];
    const hashes = await Promise.all(values.map(slowHash));
    values.forEach((value, i) => {
      if (index.id.has(hashes[i])) hits.push({ class: 'id', value });
    });
    for (const org of set.org) {
      if (text.includes(org)) hits.push({ class: 'org', value: org });
    }
  }
  return hits;
}

/**
 * Синтетические маркеры само-проверки — по одному на строгий и числовой класс.
 *
 * Значений корпуса здесь нет: фамилия выдумана, номер взят из диапазона,
 * которого в реквизитах не встречается, отпечаток набран словами. Их хэши
 * входят в `MARKER_SET` наравне с настоящими, поэтому детектор обязан
 * покраснеть на них — и краснеет он в памяти, отдельным шагом, не появляясь в
 * дереве и не мешая обычному прогону.
 *
 * Экспортируются, чтобы тестам не пришлось повторять эти строки у себя:
 * значение маркера должно жить в одном месте, иначе рано или поздно копия
 * разойдётся с оригиналом и тест начнёт проверять несуществующий маркер.
 */
export const SELF_TEST_MARKERS = Object.freeze({
  surname: 'Зюмбюльников',
  id: '9990000019',
  cert: 'FEEDFACE00CAFEBABE0000DEADBEEF11',
});

/** Фикстура само-проверки: те же маркеры в правдоподобном окружении. */
export const SELF_TEST_TEXT =
  `Согласовал ${SELF_TEST_MARKERS.surname} А. А., ИНН ${SELF_TEST_MARKERS.id}, ` +
  `сертификат ${SELF_TEST_MARKERS.cert}.`;

/** Классы, срабатывание которых обязано подтвердиться на фикстуре. */
const SELF_TEST_CLASSES = Object.freeze(['surname', 'cert', 'id']);

/**
 * Прогоняет детектор по фикстуре и требует срабатывания каждого класса.
 *
 * Без этого шага протухший детектор — сломанный регэксп, изменившаяся
 * нормализация, перепутанная функция хэширования — выглядел бы как чистое
 * дерево, то есть как успех.
 */
export async function selfTest(set = MARKER_SET) {
  const hits = await scanText(SELF_TEST_TEXT, { set });
  const found = new Set(hits.map((hit) => hit.class));
  const missing = SELF_TEST_CLASSES.filter((cls) => !found.has(cls));
  if (missing.length > 0) {
    throw new Error(
      `Само-проверка не сработала: на синтетической фикстуре не найдены классы ${missing.join(', ')}.\n` +
        'Сканирование не выполнено: детектор, молчащий на заведомом маркере, ' +
        'даст «чисто» и на настоящем.',
    );
  }
}

/**
 * Перечисляет ОТСЛЕЖИВАЕМЫЕ и новые файлы.
 *
 * Прежде читался только `git ls-files`, то есть барьер не видел файл до
 * `git add`. На S9 через эту щель в код уехали настоящие ИНН и ОГРН корпуса:
 * `pnpm pii:scan` отвечал «чисто», потому что новых файлов этапа для него не
 * существовало. Барьер, срабатывающий только после staging, узнаёшь уже в
 * коммите — то есть тогда, когда он бесполезен.
 *
 * `--others --exclude-standard` добавляет новые файлы, не попавшие под
 * `.gitignore`: закрытый корпус в `GOLDEN_CORPUS_DIR` по-прежнему вне охвата,
 * и это верно — он в репозиторий и не попадёт.
 */
export function listScannedFiles() {
  const listed = [
    ...execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8',
    }).split('\n'),
  ];
  return [...new Set(listed)]
    .filter(Boolean)
    .filter((file) => !SELF.test(file))
    .filter((file) => !BINARY.test(file));
}

/**
 * Сканирует дерево целиком.
 *
 * Числовые кандидаты собираются по ВСЕМ файлам сразу и хэшируются одним
 * `Promise.all`: scrypt считается на пуле libuv, и параллелизм внутри одного
 * файла — это единицы вызовов вместо сотен. После прогрева кэша обход файлов
 * идёт по готовым значениям.
 */
export async function scanRepository(files = listScannedFiles(), set = MARKER_SET) {
  const sources = [];
  const warm = new Set();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const includeCodeOnly = !DOCS_ALLOWED.test(file);
    sources.push({ file, text, includeCodeOnly });
    if (includeCodeOnly) for (const value of collectCandidates(text).id) warm.add(value);
  }
  await Promise.all([...warm].map(slowHash));

  const hits = [];
  for (const { file, text, includeCodeOnly } of sources) {
    for (const hit of await scanText(text, { set, includeCodeOnly })) hits.push({ file, ...hit });
  }
  return { scanned: sources.length, candidates: warm.size, hits };
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

/** Читаемое имя класса для сообщения об ошибке. */
const CLASS_TITLES = Object.freeze({
  surname: 'фамилия',
  cert: 'отпечаток сертификата',
  id: 'ИНН или ОГРН',
  org: 'наименование организации',
});

async function main() {
  const started = hrtime.bigint();
  try {
    verifyMarkerSet();
    await selfTest();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
  }

  const { scanned, candidates, hits } = await scanRepository();
  const seconds = Number(hrtime.bigint() - started) / 1e9;

  if (hits.length > 0) {
    console.error('Найдены персональные данные корпуса в файлах репозитория:\n');
    for (const hit of hits) {
      console.error(`  ${hit.file}: ${CLASS_TITLES[hit.class]} «${hit.value}»`);
    }
    console.error('\nЗамените синтетическими значениями (§1.4 плана).');
    exit(1);
  }

  const total =
    MARKER_SET.surname.length +
    MARKER_SET.cert.length +
    MARKER_SET.id.length +
    MARKER_SET.org.length;
  // eslint-disable-next-line no-console -- stdout и есть интерфейс этого скрипта
  console.log(
    `Сканирование ПДн: чисто (${scanned} файлов, ${total} маркеров, ` +
      `${candidates} числовых кандидатов, ${seconds.toFixed(1)} с).`,
  );
}

/** Файл остаётся исполняемым скриптом, но при импорте ничего не запускает. */
const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) await main();
