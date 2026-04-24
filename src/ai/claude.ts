export const CLAUDE_MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

function headers(apiKey: string) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

// ─── One-shot completion ──────────────────────────────────────────────────────

export async function complete(
  apiKey: string,
  userPrompt: string,
  opts?: { maxTokens?: number; system?: string },
): Promise<string> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: opts?.maxTokens ?? 2048,
      system: opts?.system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
  return data.content.find((b) => b.type === 'text')?.text ?? '';
}

// ─── Streaming completion ─────────────────────────────────────────────────────

export async function stream(
  apiKey: string,
  userPrompt: string,
  onChunk: (text: string) => void,
  opts?: { maxTokens?: number; system?: string; signal?: AbortSignal },
): Promise<void> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: headers(apiKey),
    signal: opts?.signal,
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: opts?.maxTokens ?? 8192,
      stream: true,
      system: opts?.system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            onChunk(evt.delta.text);
          }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function describeStep(i: { type: string; target: { tagName: string; text?: string; selector: string; inputType?: string; value?: string }; pageUrl: string }): string {
  const t = i.target;
  const el = t.text ? `"${t.text}"` : t.selector;
  switch (i.type) {
    case 'click':
      return t.tagName === 'a' ? `Clicked link ${el}` : `Clicked button ${el}`;
    case 'input':
      return t.inputType === 'password' ? `Entered password in ${el}` : `Typed "${t.value ?? ''}" into ${el}`;
    case 'submit':
      return `Submitted form at ${t.text ?? t.selector}`;
    default:
      return `Interacted with ${el}`;
  }
}

export function buildNarrativePrompt(spec: {
  metadata: { flowName: string; flowGoal: string; durationSeconds: number };
  pages: Array<{ title: string; url: string; components: Array<{ role: string }> }>;
  interactions: Array<{ type: string; target: { tagName: string; text?: string; selector: string; inputType?: string; value?: string }; pageUrl: string }>;
  apiCalls: Array<{ method: string; url: string; responseStatus: number }>;
}): string {
  const { metadata, pages, interactions, apiCalls } = spec;
  return `You are analyzing a recorded user journey through a web application.

Flow: "${metadata.flowName}"
Goal: ${metadata.flowGoal || 'Not specified'}
Duration: ${Math.round(metadata.durationSeconds)}s
Pages: ${pages.map((p) => `${p.title || 'Untitled'} (${p.url})`).join(' → ')}

Steps (${interactions.length}):
${interactions
  .slice(0, 30)
  .map((i, n) => `${n + 1}. ${describeStep(i)}`)
  .join('\n')}

API calls:
${apiCalls.slice(0, 15).map((c) => `- ${c.method} ${c.url} → ${c.responseStatus}`).join('\n') || 'None captured'}

Write a concise technical summary with exactly these three sections:

**Summary**
2–3 sentences describing what this flow accomplishes from the user's perspective.

**Flow Steps**
Numbered plain-English description of each meaningful action (merge trivial sub-steps).

**Key UI Components**
Bullet list of the distinct UI components a developer needs to build, named specifically (e.g. "Login form with email + password fields", "Dashboard navigation sidebar").

Be specific. Use the actual URLs, labels, and API endpoints provided.`;
}

export function buildCodeGenPrompt(spec: {
  aiSystemPrompt: string;
  metadata: { flowName: string };
}): string {
  return `${spec.aiSystemPrompt}

---

Output a complete, working implementation. Structure your response as multiple files using this exact format for each file:

=== path/to/filename.ext ===
<file contents>

Include:
- frontend/src/ — React 18 + TypeScript + Tailwind CSS components and pages
- backend/src/ — Node.js + Express + TypeScript API routes matching the captured endpoints
- frontend/package.json and backend/package.json
- A short README.md with setup instructions

Do not omit any file. Do not add placeholder comments — write real, working code.`;
}
