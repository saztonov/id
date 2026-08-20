import { describe, expect, it } from 'vitest';
import { pgConnectionOptions } from './pg-ssl.js';

describe('pgConnectionOptions', () => {
  it('вырезает sslmode и sslrootcert из URL', () => {
    const { connectionString, ssl } = pgConnectionOptions(
      'postgres://u:p@h:6432/ID?sslmode=verify-full&sslrootcert=/x.crt&application_name=id',
    );
    const url = new URL(connectionString);
    expect(url.searchParams.has('sslmode')).toBe(false);
    expect(url.searchParams.has('sslrootcert')).toBe(false);
    expect(url.searchParams.get('application_name')).toBe('id');
    expect(ssl).toBeUndefined();
  });

  it('без CA не включает ssl', () => {
    const { ssl } = pgConnectionOptions('postgres://u:p@h:6432/ID');
    expect(ssl).toBeUndefined();
  });
});
