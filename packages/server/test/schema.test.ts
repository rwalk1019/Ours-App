import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db.ts';

describe('ours schema', () => {
  it('applies once, forces RLS, and denies a non-bypass role', async () => {
    const db = await openDatabase();
    await migrate(db);
    await migrate(db);
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = tables.rows.map((row) => row.tablename);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith('ours_'))).toBe(true);
    const policies = await db.query(`SELECT policyname FROM pg_policies WHERE schemaname = 'public'`);
    expect(policies.rows).toHaveLength(0);
    const flags = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    );
    expect(flags.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    await db.exec(`
      CREATE ROLE ours_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT ours_probe TO CURRENT_USER;
      GRANT USAGE ON SCHEMA public TO ours_probe;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ours_probe;
    `);
    await db.exec('SET ROLE ours_probe');
    const visible = await db.query('SELECT id FROM ours_settings');
    expect(visible.rows).toHaveLength(0);
    await expect(
      db.query(`INSERT INTO ours_custom_items (name, kind, role, value_cents, as_of) VALUES ('Sample house', 'asset', 'house', 1, '2026-11-01')`),
    ).rejects.toThrow();
    await db.exec('RESET ROLE');

    await db.exec(`
      CREATE ROLE ours_anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT ours_anon TO CURRENT_USER;
      GRANT USAGE ON SCHEMA public TO ours_anon;
    `);
    await db.exec('SET ROLE ours_anon');
    await expect(db.query('SELECT id FROM ours_settings')).rejects.toThrow();
    await db.exec('RESET ROLE');

    const settings = await db.query('SELECT id, tithing_bps FROM ours_settings');
    expect(settings.rows).toEqual([{ id: 1, tithing_bps: null }]);
  });
});
