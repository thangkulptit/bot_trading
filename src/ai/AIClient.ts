import type { z } from 'zod';
import type { Config } from '../config';
import { fetchJson } from '../utils';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`AI không trả JSON: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }
}

/** Client cho mọi API tương thích OpenAI Chat Completions (OpenAI, DeepSeek, Groq, OpenRouter, Ollama...). */
export class AIClient {
  constructor(private cfg: Config) {}

  get enabled(): boolean {
    return Boolean(this.cfg.AI_API_KEY);
  }

  async chat(messages: ChatMessage[], temperature = 0.2): Promise<string> {
    if (!this.enabled) throw new Error('AI chưa cấu hình (thiếu AI_API_KEY)');
    const res = await fetchJson<ChatResponse>(`${this.cfg.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.AI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.AI_MODEL,
        messages,
        temperature,
        ...(this.cfg.AI_JSON_MODE ? { response_format: { type: 'json_object' } } : {}),
      }),
      timeoutMs: this.cfg.AI_TIMEOUT_MS,
    });
    const content = res.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI trả về nội dung rỗng');
    return content;
  }

  async chatJSON<T>(system: string, user: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const content = await this.chat([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    return schema.parse(extractJson(content));
  }
}
