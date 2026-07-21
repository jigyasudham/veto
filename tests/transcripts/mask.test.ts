import { describe, it, expect } from 'vitest';
import { mask, hasSecrets, fingerprint, maskToken, REDACTED_RE } from '../../src/transcripts/mask.js';

const TOKEN = /^REDACTED\[sha256:[0-9a-f]{8}\]$/;

describe('mask() — detection + value redaction', () => {
  it('redacts a bare AWS access key (whole match)', () => {
    const r = mask('deploy with AKIA1234567890ABCDEF now');
    expect(r.count).toBe(1);
    expect(r.text).not.toContain('AKIA1234567890ABCDEF');
    expect(r.text).toMatch(/deploy with REDACTED\[sha256:[0-9a-f]{8}\] now/);
  });

  it('redacts a GitHub token', () => {
    const tok = 'ghp_' + 'a'.repeat(36);
    const r = mask(`token=${tok}`);
    expect(r.count).toBe(1);
    expect(r.text).not.toContain(tok);
  });

  it('redacts only the VALUE of password="..." and keeps the label + quotes', () => {
    const r = mask('password = "hunter2very"');
    expect(r.count).toBe(1);
    expect(r.text).not.toContain('hunter2very');
    expect(r.text).toMatch(/password = "REDACTED\[sha256:[0-9a-f]{8}\]"/);
  });

  it('redacts the password inside a Postgres connection string but keeps the host', () => {
    const r = mask('DATABASE_URL=postgres://admin:s3cretPass@db.example.com:5432/app');
    expect(r.count).toBe(1);
    expect(r.text).not.toContain('s3cretPass');
    expect(r.text).toContain('db.example.com'); // host preserved
    expect(r.text).toContain('admin'); // user preserved
  });

  it('redacts an ENTIRE multiline private key block (no body leakage)', () => {
    const key = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAsecretkeymaterialline1',
      'moresecretkeymateriallllllline2',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const r = mask(`here is the key:\n${key}\nend`);
    expect(r.count).toBe(1);
    expect(r.text).not.toContain('secretkeymaterial');
    expect(r.text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(r.text).toContain('here is the key:');
    expect(r.text).toContain('end');
  });

  it('redacts multiple secrets in one blob and counts them', () => {
    const blob = 'key AKIA1234567890ABCDEF and api_key = "abcdefghij0123456789xyz"';
    const r = mask(blob);
    expect(r.count).toBe(2);
    expect(r.text).not.toContain('AKIA1234567890ABCDEF');
    expect(r.text).not.toContain('abcdefghij0123456789xyz');
  });
});

describe('mask() — fingerprints correlate recurrences', () => {
  it('gives the same token for the same secret (correlatable) and different for different', () => {
    const a = mask('AKIA1234567890ABCDEF here AKIA1234567890ABCDEF again').text;
    // Two occurrences of the same key → same token both times.
    const tokens = a.match(REDACTED_RE)!;
    expect(tokens.length).toBe(2);
    expect(tokens[0]).toBe(tokens[1]);

    const t1 = maskToken('AKIA1234567890ABCDEF');
    const t2 = maskToken('AKIAZZZZZZZZZZZZZZZZ');
    expect(t1).not.toBe(t2);
  });

  it('collapses distinct fingerprints list by value', () => {
    const r = mask('AKIA1111111111111111 AKIA1111111111111111 AKIA2222222222222222');
    expect(r.count).toBe(3);            // three spans redacted
    expect(r.fingerprints.length).toBe(2); // but two distinct secrets
  });

  it('fingerprint is 8 lowercase hex chars and deterministic', () => {
    const fp = fingerprint('some-secret-value');
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fp).toBe(fingerprint('some-secret-value'));
    expect(maskToken('some-secret-value')).toMatch(TOKEN);
  });
});

describe('mask() — safety properties', () => {
  it('leaves secret-free text untouched (count 0)', () => {
    const clean = 'The quick brown fox refactored auth.ts and ran the tests.';
    const r = mask(clean);
    expect(r.count).toBe(0);
    expect(r.text).toBe(clean);
  });

  it('is idempotent: masking already-masked text finds nothing new', () => {
    const once = mask('password = "hunter2very" and AKIA1234567890ABCDEF').text;
    const twice = mask(once);
    expect(twice.count).toBe(0);
    expect(twice.text).toBe(once);
  });

  it('handles empty / whitespace input', () => {
    expect(mask('').count).toBe(0);
    expect(mask('   \n  ').count).toBe(0);
    expect(hasSecrets('')).toBe(false);
  });

  it('hasSecrets reflects mask()', () => {
    expect(hasSecrets('nothing here')).toBe(false);
    expect(hasSecrets('AKIA1234567890ABCDEF')).toBe(true);
  });
});
