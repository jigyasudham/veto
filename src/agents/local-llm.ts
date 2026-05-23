/**
 * Local LLM integration (Ollama / LM Studio)
 */

export async function callLocalLlm(options: {
  task: string;
  model?: string;
  provider?: 'ollama' | 'lmstudio';
}): Promise<{ success: boolean; output: string; model_used: string; provider: string }> {
  const provider = options.provider || 'ollama';
  const model = options.model || (provider === 'ollama' ? 'llama3' : 'model-q4_k_m');

  try {
    if (provider === 'ollama') {
      const resp = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          prompt: options.task,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) throw new Error(`Ollama error: ${resp.statusText}`);
      const data = await resp.json() as { response: string };
      return { success: true, output: data.response, model_used: model, provider };
    } else {
      // LM Studio (OpenAI compatible)
      const resp = await fetch('http://localhost:1234/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: options.task }],
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) throw new Error(`LM Studio error: ${resp.statusText}`);
      const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
      return { success: true, output: data.choices[0]?.message.content || '', model_used: model, provider };
    }
  } catch (err: any) {
    return {
      success: false,
      output: `Local LLM failed: ${err.message}. Ensure ${provider} is running on localhost.`,
      model_used: model,
      provider
    };
  }
}
