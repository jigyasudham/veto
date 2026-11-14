import { describe, expect, it } from 'vitest';
import { evaluate, type Input, type Note } from './selector.js';

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'note', text: 'PowerShell encoding requires explicit UTF-8 output.',
  project: 'alpha', scope: 'project', createdAt: 1, updatedAt: 1, ...overrides,
});
const input = (overrides: Partial<Input> = {}): Input => ({
  query: 'pwsh encoding', project: 'alpha', asOf: 10, consent: true,
  notes: [note()], ...overrides,
});

describe('offline lesson selector', () => {
  it('recovers an alias match without lowering the two-concept requirement', () => {
    expect(evaluate(input(), false).selected).toHaveLength(0);
    expect(evaluate(input()).selected).toHaveLength(1);
    expect(evaluate(input({ query: 'pwsh deployment' })).selected).toHaveLength(0);
    expect(evaluate(input({ query: 'pwsh powershell deployment' })).selected).toHaveLength(0);
  });
  it('does not manufacture two matches from one compound word', () => {
    expect(evaluate(input({ query: 'git-bash deployment', notes: [note({ text: 'git-bash quoting' })] })).selected).toHaveLength(0);
  });
  it('selects independent authored units from an otherwise oversized note', () => {
    const unit = 'PowerShell encoding requires explicit UTF-8 output.';
    const request = input({ notes: [note({ text: unit + '\n\n' + 'Unrelated context. '.repeat(150), units: [unit, 'Unrelated context. '.repeat(150)] })] });
    expect(evaluate({ ...request, query: 'powershell encoding' }, false).counts.overBudget).toBe(1);
    const improved = evaluate(request);
    expect(improved.selected.map(s => s.text)).toEqual([unit]);
    expect(improved.tokens).toBeLessThanOrEqual(500);
  });
  it('does not truncate oversized notes without authored boundaries', () => {
    expect(evaluate(input({ notes: [note({ text: 'PowerShell encoding '.repeat(150) })] })).counts.overBudget).toBe(1);
  });
  it('preserves consent, exclusions, project boundaries and quarantine', () => {
    expect(evaluate(input({ consent: false })).selected).toEqual([]);
    expect(evaluate(input({ excluded: true })).selected).toEqual([]);
    for (const n of [note(), note({ scope: 'machine', quarantined: true })]) {
      expect(evaluate(input({ project: 'beta', notes: [n] })).counts.scope).toBe(1);
    }
    expect(evaluate(input({ project: 'beta', notes: [note({ scope: 'machine' })] })).selected).toHaveLength(1);
  });
  it('reports exclusive temporal and eligibility exclusions', () => {
    const notes = [note({ id: 'future', createdAt: 11, updatedAt: 11 }),
      note({ id: 'changed', updatedAt: 11 }), note({ id: 'disabled', disabled: true }),
      note({ id: 'native', native: true }), note({ id: 'stale', stale: true })];
    expect(evaluate(input({ notes })).counts).toMatchObject({ notYetCreated: 1, changed: 1, disabled: 1, native: 1, stale: 1, eligible: 0 });
  });
  it('abstains on unrelated tasks and does not return rejected content in counters', () => {
    const result = evaluate(input({ query: 'postgres migration' }));
    expect(result.selected).toEqual([]);
    expect(result.counts.insufficientTerms).toBe(1);
    expect(Object.values(result.counts).every(v => typeof v === 'number')).toBe(true);
  });
  it('waits on narrow continuation phrases but accepts substantive requests', () => {
    for (const query of ['continue', 'yes', 'go ahead', 'veto_continue synthetic-id']) {
      expect(evaluate(input({ query })).reason).toBe('await_task');
    }
    expect(evaluate(input({ query: 'Continue fixing PowerShell encoding' })).reason).toBe('selected');
  });
  it('deduplicates identical text and produces stable results', () => {
    const request = input({ notes: [note({ id: 'b' }), note({ id: 'a' })] });
    expect(evaluate(request).counts.duplicate).toBe(1);
    expect(evaluate(request)).toEqual(evaluate({ ...request, notes: [...request.notes].reverse() }));
  });
});
