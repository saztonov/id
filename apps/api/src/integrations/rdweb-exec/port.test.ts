/**
 * Классификация отказов §10 — три ответа, а не два.
 *
 * Повторить, сдаться и пересобрать снимок — разные действия, и слив последнее с
 * первыми двумя портал либо крутил бы бесконечный повтор запроса, который
 * контракт повторять запрещает прямо (§17 п. 6), либо объявлял бы отказом
 * ситуацию, которая лечится пересборкой.
 */
import { describe, expect, it } from 'vitest';

import {
  ExecSyncError,
  SUCCESSFUL_BLOCK_STATUSES,
  SUCCESSFUL_SYNC_STATES,
  TERMINAL_SYNC_STATES,
} from './port.js';

function error(status: number | undefined, code: string | null = null): ExecSyncError {
  return new ExecSyncError('тест', {
    ...(status === undefined ? {} : { status }),
    code,
    operation: 'sync_init',
  });
}

describe('повторять или нет', () => {
  it.each([
    ['сеть или таймаут', undefined],
    ['429 rate_limited', 429],
    ['500', 500],
    ['503', 503],
  ])('%s — повторяем', (_name, status) => {
    const failure = error(status as number | undefined);
    expect(failure.retriable).toBe(true);
    expect(failure.permanent).toBe(false);
  });

  it.each([
    ['400 invalid_json', 400, 'invalid_json'],
    ['401 invalid_principal', 401, 'invalid_principal'],
    ['403 scope_forbidden', 403, 'scope_forbidden'],
    ['403 project_forbidden', 403, 'project_forbidden'],
    ['404 executive_disabled', 404, 'executive_disabled'],
    ['404 sync_not_found', 404, 'sync_not_found'],
    ['413 document_too_large', 413, 'document_too_large'],
    ['415 unsupported_document_type', 415, 'unsupported_document_type'],
    ['422 invalid_manifest', 422, 'invalid_manifest'],
    ['422 page_geometry_mismatch', 422, 'page_geometry_mismatch'],
    ['422 upload_not_verified', 422, 'upload_not_verified'],
  ])('%s — не повторяем и не конфликт', (_name, status, code) => {
    const failure = error(status as number, code as string);
    expect(failure.retriable).toBe(false);
    expect(failure.conflict).toBeNull();
    expect(failure.permanent).toBe(true);
  });
});

describe('конфликты §9 — пересобрать снимок, а не повторить', () => {
  it.each([
    ['sync_identity_conflict', 'sync_identity'],
    ['generation_conflict', 'generation'],
    ['stale_generation', 'stale_generation'],
    ['stale_base_generation', 'stale_base_generation'],
    ['block_revision_conflict', 'block_revision'],
  ])('%s → %s', (code, kind) => {
    const failure = error(409, code);
    expect(failure.conflict).toBe(kind);
    // Ни повтор, ни «сдаться»: у конфликта собственный ответ.
    expect(failure.retriable).toBe(false);
    expect(failure.permanent).toBe(false);
  });

  it('409 с незнакомым кодом всё равно конфликт: повторять его нельзя', () => {
    expect(error(409, 'что-то новое').conflict).toBe('generation');
    expect(error(409, null).conflict).toBe('generation');
  });
});

describe('Retry-After сильнее нашей экспоненты', () => {
  it('сохраняется в миллисекундах', () => {
    const failure = new ExecSyncError('перегрузка', {
      status: 429,
      code: 'rate_limited',
      operation: 'sync_read',
      retryAfterMs: 30_000,
    });
    expect(failure.retryAfterMs).toBe(30_000);
    expect(failure.retriable).toBe(true);
  });
});

describe('множества состояний', () => {
  it('superseded терминально, но не успешно', () => {
    expect(TERMINAL_SYNC_STATES.has('superseded')).toBe(true);
    expect(SUCCESSFUL_SYNC_STATES.has('superseded')).toBe(false);
  });

  it('completed_with_issues — успех: перечень неисполнимого лежит отдельно', () => {
    expect(SUCCESSFUL_SYNC_STATES.has('completed_with_issues')).toBe(true);
  });

  it('suspicious успехом НЕ считается (§11)', () => {
    expect(SUCCESSFUL_BLOCK_STATUSES.has('suspicious')).toBe(false);
    for (const status of ['success', 'reused', 'unchanged', 'deleted']) {
      expect(SUCCESSFUL_BLOCK_STATUSES.has(status)).toBe(true);
    }
  });

  it('нетерминальные состояния не попали в терминальные', () => {
    for (const state of ['accepted', 'uploading', 'rendering', 'queued', 'running']) {
      expect(TERMINAL_SYNC_STATES.has(state)).toBe(false);
    }
  });
});
