/**
 * Ошибки в форме FastAPI.
 *
 * Legacy RD WEB — это FastAPI, и любой отказ там приходит телом `{"detail": "..."}`
 * (и `HTTPException`, и ошибки валидации Pydantic после нормализации обработчиком).
 * Адаптер портала разбирает именно это поле, поэтому двойник обязан отвечать так же:
 * иначе тесты адаптера зелёные на фейке и красные на боевом API.
 */

/** Отказ, который роут отдаёт телом `{"detail": ...}` с заданным статусом. */
export class HttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** 401 — отсутствующий/просроченный/неизвестный Bearer на защищённом маршруте. */
export function unauthorized(detail = 'Не аутентифицирован'): HttpError {
  return new HttpError(401, detail);
}

/** 404 — сущность не найдена (у них это `NotFoundError` через глобальный обработчик). */
export function notFound(detail: string): HttpError {
  return new HttpError(404, detail);
}

/** 409 — конфликт инвариантов (чужой проект, нет страниц, не отрендерено). */
export function conflict(detail: string): HttpError {
  return new HttpError(409, detail);
}

/** 422 — отказ валидации тела/геометрии/лимитов. */
export function unprocessable(detail: string): HttpError {
  return new HttpError(422, detail);
}
