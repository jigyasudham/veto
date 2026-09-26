import { describe, expect, it } from 'vitest';
import { analyze } from '../../src/agents/security/scanner.js';

const sql = (code: string) => analyze(code).findings.filter(f => f.cwe === 'CWE-89');

describe('SQL injection rules', () => {
  it("catches the textbook case the old rule missed: a quoted literal inside the SQL string", () => {
    const f = sql(`const a = 1;\nconst rows = await db.query("SELECT * FROM users WHERE id = '" + req.params.id + "'");`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'critical', location: 'line 2' });
  });

  it('catches request input in a SQL template string', () => {
    expect(sql('db.query(`DELETE FROM orders WHERE id = ${req.body.id}`)')[0]?.severity).toBe('critical');
  });

  it('flags concatenation of a plain variable at medium severity, once', () => {
    const f = sql(`db.query('SELECT * FROM t WHERE name = ' + name);`);
    expect(f).toEqual([expect.objectContaining({ severity: 'medium' })]);
  });

  it('leaves parameterised queries alone', () => {
    expect(sql(`db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);`)).toEqual([]);
    expect(sql('const msg = "Select an option" + suffix;')).toEqual([]);
  });
});
