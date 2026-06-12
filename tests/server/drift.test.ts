import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, recordToolCall } from '../../src/memory/local.js';
import { autoSave } from '../../src/server/runtime.js';
import { callTool } from '../../src/server.js';

beforeEach(() => {
  resetDb();
  // Reset autoSave mock/live references
  autoSave.last_session_id = null;
});

describe('veto_drift_check tool', () => {
  it('returns error when no active or saved sessions exist', async () => {
    const res: any = await callTool({
      params: {
        name: 'veto_drift_check',
        arguments: {}
      }
    });
    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(false);
    expect(body.message).toContain('No active or saved sessions found');
  });

  it('detects a clean trace as GREEN with no loops', async () => {
    const sessionId = 'test-session-clean';
    autoSave.last_session_id = sessionId;

    // Record some successful tool calls
    recordToolCall({ session_id: sessionId, tool_name: 'veto_status', result_status: 'success', duration_ms: 10 });
    recordToolCall({ session_id: sessionId, tool_name: 'veto_route_task', result_status: 'success', duration_ms: 15 });
    recordToolCall({ session_id: sessionId, tool_name: 'veto_memory_search', result_status: 'success', duration_ms: 20 });

    const res: any = await callTool({
      params: {
        name: 'veto_drift_check',
        arguments: { session_id: sessionId }
      }
    });

    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.verdict).toBe('GREEN');
    expect(body.loop_detected).toBe(false);
    expect(body.heuristics.total_calls).toBe(3);
    expect(body.heuristics.consecutive_failures).toBe(0);
    expect(body.heuristics.error_rate).toBe(0);
  });

  it('detects 3 consecutive failures as YELLOW and sets loop_detected = true', async () => {
    const sessionId = 'test-session-yellow';
    autoSave.last_session_id = sessionId;

    recordToolCall({ session_id: sessionId, tool_name: 'run_command', result_status: 'success', duration_ms: 10 });
    recordToolCall({ session_id: sessionId, tool_name: 'run_command', result_status: 'error', error_message: 'compilation error', duration_ms: 10 });
    recordToolCall({ session_id: sessionId, tool_name: 'run_command', result_status: 'error', error_message: 'compilation error', duration_ms: 10 });
    recordToolCall({ session_id: sessionId, tool_name: 'run_command', result_status: 'error', error_message: 'compilation error', duration_ms: 10 });

    const res: any = await callTool({
      params: {
        name: 'veto_drift_check',
        arguments: { session_id: sessionId }
      }
    });

    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.verdict).toBe('YELLOW');
    expect(body.loop_detected).toBe(true);
    expect(body.heuristics.consecutive_failures).toBe(3);
    expect(body.heuristics.error_rate).toBe(75);
    expect(body.heuristics.repeated_errors).toHaveLength(1);
    expect(body.heuristics.repeated_errors[0].error_message).toBe('compilation error');
    expect(body.heuristics.repeated_errors[0].count).toBe(3);
  });

  it('detects 5 consecutive failures or repeated errors as RED', async () => {
    const sessionId = 'test-session-red';
    autoSave.last_session_id = sessionId;

    for (let i = 0; i < 5; i++) {
      recordToolCall({ session_id: sessionId, tool_name: 'run_command', result_status: 'error', error_message: 'fatal crash', duration_ms: 10 });
    }

    const res: any = await callTool({
      params: {
        name: 'veto_drift_check',
        arguments: { session_id: sessionId }
      }
    });

    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.verdict).toBe('RED');
    expect(body.loop_detected).toBe(true);
    expect(body.heuristics.consecutive_failures).toBe(5);
    expect(body.heuristics.repeated_errors[0].error_message).toBe('fatal crash');
    expect(body.heuristics.repeated_errors[0].count).toBe(5);
  });

  it('detects high tool repetition', async () => {
    const sessionId = 'test-session-repetition';
    autoSave.last_session_id = sessionId;

    // 4 consecutive calls of the same tool
    recordToolCall({ session_id: sessionId, tool_name: 'replace_file_content', result_status: 'success', duration_ms: 10 });
    recordToolCall({ session_id: sessionId, tool_name: 'replace_file_content', result_status: 'success', duration_ms: 10 });
    recordToolCall({ session_id: sessionId, tool_name: 'replace_file_content', result_status: 'success', duration_ms: 10 });
    recordToolCall({ session_id: sessionId, tool_name: 'replace_file_content', result_status: 'success', duration_ms: 10 });

    const res: any = await callTool({
      params: {
        name: 'veto_drift_check',
        arguments: { session_id: sessionId }
      }
    });

    const body = JSON.parse(res.content[0].text);
    expect(body.success).toBe(true);
    expect(body.heuristics.max_consecutive_tool).toBe('replace_file_content');
    expect(body.heuristics.max_consecutive_tool_count).toBe(4);
    // 4 consecutive tools is loop_detected=true (YELLOW verdict)
    expect(body.loop_detected).toBe(true);
    expect(body.verdict).toBe('YELLOW');
  });
});
