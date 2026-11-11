import { describe, expect, it } from 'vitest';
import { looksLikeSetupCode } from './codes';

describe('looksLikeSetupCode', () => {
  it('recognizes a 3-by-4 setup code and ignores dashes and case', () => {
    expect(looksLikeSetupCode('ABCD-EFGH-JKMN')).toBe(true);
    expect(looksLikeSetupCode('abcdefghjkmn')).toBe(true);
    expect(looksLikeSetupCode(' abcd efgh jkmn ')).toBe(true);
  });

  it('rejects backup-length and empty values', () => {
    expect(looksLikeSetupCode('ABCDE-FGHJK')).toBe(false);
    expect(looksLikeSetupCode('ABCDEFGHJK')).toBe(false);
    expect(looksLikeSetupCode('')).toBe(false);
    expect(looksLikeSetupCode('ABCD-EFGH-JKM')).toBe(false);
  });
});
