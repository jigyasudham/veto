import { describe, it, expect } from 'vitest';
import { workerHandlers } from '../../src/server/handlers/workers.js';

describe('worker handler registry', () => {
  it('registers the expected pure agentic-worker tools', () => {
    expect(Object.keys(workerHandlers).sort()).toEqual([
      'veto_a11y_advisor', 'veto_api_contract', 'veto_code_review', 'veto_explain',
      'veto_lint_rules', 'veto_merge_conflict', 'veto_playwright', 'veto_sdd_agent',
      'veto_secrets_scan', 'veto_security_scan', 'veto_semantic_search', 'veto_summarize',
      'veto_test_gaps', 'veto_translate', 'veto_type_coverage',
    ].sort());
  });

  it('each handler delegates to the agentic worker loop (fallback envelope without Sampling)', async () => {
    const res: any = await workerHandlers.veto_code_review({ request: {}, args: { task: 'review x' } });
    const body = JSON.parse(res.content[0].text);
    expect(body.mode).toBe('agentic_fallback');
    expect(body.llm_upgrade.prompt.agent).toBe('reviewer');
  });

  it('veto_explain picks coder when a file_path is supplied, else debugger', async () => {
    const withFile: any = await workerHandlers.veto_explain({ request: {}, args: { file_path: 'a.ts' } });
    const withoutFile: any = await workerHandlers.veto_explain({ request: {}, args: { text: 'what is this' } });
    expect(JSON.parse(withFile.content[0].text).llm_upgrade.prompt.agent).toBe('coder');
    expect(JSON.parse(withoutFile.content[0].text).llm_upgrade.prompt.agent).toBe('debugger');
  });
});
