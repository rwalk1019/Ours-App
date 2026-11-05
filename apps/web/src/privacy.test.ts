import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'demo' || name.includes('.test.')) return [];
    if (statSync(path).isDirectory()) return files(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

describe('locked frontend privacy', () => {
  it('does not persist household data in the browser', () => {
    const source = files(join(import.meta.dirname, '.')).map((path) => readFileSync(path, 'utf8')).join('\n');
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});
