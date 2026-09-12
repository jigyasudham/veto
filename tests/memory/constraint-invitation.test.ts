import { describe, it, expect, beforeEach } from 'vitest';
import { callTool } from '../../src/server.js';
import { resetDb } from '../../src/memory/local.js';
import { getInvitation, invitationStats, listConstraints } from '../../src/memory/decisions.js';

// v3.3 step 1 (council 27cf8bcb): after a verdict, Veto asks once whether it
// should become a constraint, and records the answer locally.
beforeEach(() => resetDb());

function call(name: string, args: Record<string, unknown>): Promise<any> {
  return callTool({ params: { name, arguments: args } });
}

// Results that lead with human-readable text put the JSON payload last.
// JSON.stringify never emits a blank line, so the last one marks where it starts.
function payload(res: any): any {
  const text: string = res.content[0].text;
  const start = text.lastIndexOf('\n\n{');
  return JSON.parse(start >= 0 ? text.slice(start + 2) : text);
}

type Verdict = 'approve' | 'warn' | 'block';
const vote = (verdict: Verdict) => ({ verdict, reason: `${verdict} reason`, concerns: [] });
const votes = (overrides: Record<string, ReturnType<typeof vote>> = {}) => ({
  lead_dev: vote('approve'), pm: vote('approve'), architect: vote('approve'), ux: vote('approve'),
  devil: vote('approve'), legal: vote('approve'), security: vote('approve'), ...overrides,
});

const TASK = 'Use Postgres, not MongoDB, for the orders service';

// The LLM-backed second phase: the verdict the user acts on.
async function finalVerdict(agent_responses = votes()): Promise<any> {
  return payload(await call('veto_council_debate', { task: TASK, agent_responses }));
}

describe('the offer', () => {
  it('a final council verdict carries one invitation', async () => {
    const p = await finalVerdict();
    expect(p.final_verdict).toBe('GREEN');
    expect(p.constraint_invitation.invitation_id).toBeTruthy();
    expect(p.constraint_invitation.instruction).toMatch(/veto_decisions/);
    expect(invitationStats()).toEqual({ offered: 1, accepted: 0, declined: 0, unanswered: 1 });
  });

  it('so does a RED one: "we will not do this" is enforceable too', async () => {
    const p = await finalVerdict(votes({ security: vote('block') }));
    expect(p.final_verdict).toBe('RED');
    expect(p.constraint_invitation).toBeDefined();
  });

  it('a deadlock settled nothing, so it asks nothing', async () => {
    const p = await finalVerdict(votes({ pm: vote('block'), ux: vote('block') }));
    expect(p.final_verdict).toBe('DEADLOCK');
    expect(p.constraint_invitation).toBeUndefined();
    expect(invitationStats().offered).toBe(0);
  });

  it('the deterministic first phase never asks: it always hands off to the final verdict', async () => {
    const p = payload(await call('veto_council_debate', { task: TASK }));
    expect(p.llm_upgrade).toBeDefined();
    expect(p.constraint_invitation).toBeUndefined();
    expect(invitationStats().offered).toBe(0);
  });

  it('an ADR written from a verdict the council already asked about stays silent', async () => {
    const council = await finalVerdict();
    const adr = payload(await call('veto_adr', { task: TASK, verdict: 'GREEN', recommended: 'Postgres', outcome_id: council.outcome_id }));
    expect(adr.success).toBe(true);
    expect(adr.constraint_invitation).toBeUndefined();
    expect(invitationStats().offered).toBe(1);
  });

  it('an ADR recorded without a council verdict asks', async () => {
    const adr = payload(await call('veto_adr', { task: TASK, verdict: 'GREEN', recommended: 'Postgres' }));
    expect(adr.constraint_invitation.invitation_id).toBeTruthy();
  });

  it('a deferred ADR asks nothing', async () => {
    const adr = payload(await call('veto_adr', { task: TASK, verdict: 'DEADLOCK', recommended: 'undecided' }));
    expect(adr.constraint_invitation).toBeUndefined();
  });
});

describe('the answer', () => {
  it('yes: add with the invitation id saves the rule, links it, and counts as accepted', async () => {
    const id = (await finalVerdict()).constraint_invitation.invitation_id;
    const res = payload(await call('veto_decisions', {
      action: 'add', invitation_id: id,
      rule: 'Orders use Postgres, not Mongo', forbidden_patterns: ['mongoose', 'mongodb'],
    }));
    expect(res.success).toBe(true);
    expect(res.invitation).toEqual({ id, result: 'recorded' });
    expect(getInvitation(id)?.constraint_id).toBe(res.constraint.id);
    expect(invitationStats()).toEqual({ offered: 1, accepted: 1, declined: 0, unanswered: 0 });
  });

  it('no: decline counts as declined, and only once', async () => {
    const id = (await finalVerdict()).constraint_invitation.invitation_id;
    expect(payload(await call('veto_decisions', { action: 'decline', invitation_id: id })).success).toBe(true);
    expect((await call('veto_decisions', { action: 'decline', invitation_id: id })).isError).toBe(true);
    expect(invitationStats()).toEqual({ offered: 1, accepted: 0, declined: 1, unanswered: 0 });
  });

  it('a later yes on a declined invitation saves the rule without rewriting the answer', async () => {
    const id = (await finalVerdict()).constraint_invitation.invitation_id;
    await call('veto_decisions', { action: 'decline', invitation_id: id });
    const res = payload(await call('veto_decisions', { action: 'add', invitation_id: id, rule: 'r', forbidden_patterns: ['mongoose'] }));
    expect(res.success).toBe(true);
    expect(res.invitation.result).toBe('already_answered');
    expect(listConstraints()).toHaveLength(1);
    expect(invitationStats()).toEqual({ offered: 1, accepted: 0, declined: 1, unanswered: 0 });
  });

  it('an unknown invitation id never costs the user their rule', async () => {
    const res = payload(await call('veto_decisions', { action: 'add', invitation_id: 'no-such-id', rule: 'r', forbidden_patterns: ['mongoose'] }));
    expect(res.success).toBe(true);
    expect(res.invitation.result).toBe('not_found');
    expect(listConstraints()).toHaveLength(1);
  });

  it('decline requires an invitation id', async () => {
    expect((await call('veto_decisions', { action: 'decline' })).isError).toBe(true);
  });

  it('list reports the counts', async () => {
    await finalVerdict();
    expect(payload(await call('veto_decisions', { action: 'list' })).invitations)
      .toEqual({ offered: 1, accepted: 0, declined: 0, unanswered: 1 });
  });
});
