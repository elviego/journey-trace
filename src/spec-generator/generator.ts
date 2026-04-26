import { v4 as uuidv4 } from 'uuid';
import type {
  JourneySpec,
  SessionState,
  SessionMetadata,
  PageSpec,
  NavigationStep,
  InteractionEvent,
  ApiCallSpec,
} from '../types/spec';

// ─── Describe an interaction in plain English ─────────────────────────────────

function describeInteraction(event: InteractionEvent): string {
  const t = event.target;
  const el = t.text ? `"${t.text}"` : t.selector;

  switch (event.type) {
    case 'click':
      if (t.tagName === 'a') return `Clicked link ${el}`;
      if (t.tagName === 'button') return `Clicked button ${el}`;
      return `Clicked ${t.tagName} ${el}`;
    case 'input':
      if (t.inputType === 'password') return `Entered password in ${el}`;
      return `Typed "${t.value ?? ''}" into ${el}`;
    case 'submit':
      return `Submitted form at ${t.text ?? t.selector}`;
    case 'select':
      return `Selected "${t.value}" from ${el}`;
    case 'navigate':
      return `Navigated to ${event.pageUrl}`;
    default:
      return `Interacted with ${el}`;
  }
}

// ─── Extract meaningful page info from rrweb events ──────────────────────────

function buildPageSpecs(state: SessionState): PageSpec[] {
  return Object.values(state.pages)
    .sort((a, b) => new Date(a.visitedAt).getTime() - new Date(b.visitedAt).getTime())
    .map((p) => ({
      ...p,
      screenshot: state.screenshots.find((s) => s.pageUrl === p.url)?.dataUrl,
    }));
}

// ─── Infer navigation trigger from surrounding events ────────────────────────

function enrichNavigationFlow(flow: NavigationStep[], interactions: InteractionEvent[]): NavigationStep[] {
  return flow.map((step) => {
    const nearby = interactions.find(
      (i) => Math.abs(i.timestamp - step.timestamp) < 1500,
    );
    if (!nearby) return step;
    if (nearby.type === 'submit') return { ...step, trigger: 'form_submit' };
    if (nearby.type === 'click' && nearby.target.tagName === 'a') return { ...step, trigger: 'link' };
    return step;
  });
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderMarkdown(spec: Omit<JourneySpec, 'generatedMarkdown' | 'aiSystemPrompt'>): string {
  const m = spec.metadata;
  const lines: string[] = [];

  lines.push(`# Flow: ${m.flowName || 'Untitled Flow'}`);
  lines.push('');
  if (m.flowGoal) {
    lines.push('## Goal');
    lines.push(m.flowGoal);
    lines.push('');
  }

  lines.push('## Session Info');
  lines.push(`- **Start URL:** ${m.startUrl}`);
  lines.push(`- **Duration:** ${Math.round(m.durationSeconds)}s`);
  lines.push(`- **Recorded:** ${new Date(m.startedAt).toLocaleString()}`);
  lines.push(`- **Viewport:** ${m.viewport.width}×${m.viewport.height}`);
  lines.push('');

  if (spec.navigationFlow.length > 0) {
    lines.push('## Pages Visited');
    spec.navigationFlow.forEach((step, i) => {
      const page = spec.pages.find((p) => p.url === step.toUrl);
      lines.push(`${i + 1}. **${page?.title || step.toUrl}** — \`${step.toUrl}\``);
    });
    lines.push('');
  }

  if (spec.pages.length > 0) {
    lines.push('## UI Components Detected');
    spec.pages.forEach((page) => {
      if (!page.components.length) return;
      lines.push(`### ${page.title || page.url}`);
      const roleGroups: Record<string, number> = {};
      page.components.forEach((c) => {
        roleGroups[c.role] = (roleGroups[c.role] ?? 0) + 1;
      });
      Object.entries(roleGroups).forEach(([role, count]) => {
        lines.push(`- ${count}× \`${role}\``);
      });
      lines.push('');
    });
  }

  if (spec.interactions.length > 0) {
    lines.push('## Step-by-Step Flow');
    spec.interactions.forEach((event, i) => {
      lines.push(`${i + 1}. ${describeInteraction(event)}`);
    });
    lines.push('');
  }

  if (spec.userAnnotations.length > 0) {
    lines.push('## Milestones');
    spec.userAnnotations
      .filter((a) => a.type === 'milestone')
      .forEach((a) => {
        lines.push(`- **${a.text}** _(${formatRelativeTime(a.timestamp, m.startedAt)})_`);
      });
    lines.push('');
  }

  if (spec.apiCalls.length > 0) {
    lines.push('## API Contracts');
    spec.apiCalls.forEach((call) => {
      lines.push(`### ${call.method} ${call.url}`);
      lines.push(`- Status: ${call.responseStatus}`);
      lines.push(`- Duration: ${call.durationMs}ms`);
      if (call.requestBody) {
        lines.push('- Request:');
        lines.push('```json');
        lines.push(JSON.stringify(call.requestBody, null, 2));
        lines.push('```');
      }
      if (call.responseBody) {
        lines.push('- Response:');
        lines.push('```json');
        lines.push(JSON.stringify(call.responseBody, null, 2));
        lines.push('```');
      }
      lines.push('');
    });
  }

  return lines.join('\n');
}

function formatRelativeTime(ts: number, startedAt: string): string {
  const diff = Math.round((ts - new Date(startedAt).getTime()) / 1000);
  return diff < 60 ? `${diff}s` : `${Math.floor(diff / 60)}m ${diff % 60}s`;
}

// ─── AI prompt renderer ───────────────────────────────────────────────────────

function renderAiPrompt(spec: Omit<JourneySpec, 'generatedMarkdown' | 'aiSystemPrompt'>): string {
  const techStack = inferTechStack(spec.apiCalls);

  return `You are a senior full-stack developer. Build a complete web application that replicates the following user flow.

## Target Tech Stack
- Frontend: React 18 + TypeScript + Tailwind CSS
- Backend: ${techStack.backend}
- Database: ${techStack.db}
- API style: ${techStack.apiStyle}

## Requirements
1. Implement all pages and UI components listed in the specification
2. Implement all API endpoints shown with their request/response schemas
3. Match the navigation flow exactly
4. Handle all form validations and error states shown
5. Use semantic HTML and accessible ARIA attributes
6. Password fields must use type="password" and never be logged

## Journey Specification

${spec.metadata.flowName ? `**Flow:** ${spec.metadata.flowName}` : ''}
${spec.metadata.flowGoal ? `**Goal:** ${spec.metadata.flowGoal}` : ''}

### Pages (${spec.pages.length})
${spec.pages.map((p) => `- ${p.title || p.url}: ${(p.components ?? []).map((c) => c.role).join(', ')}`).join('\n')}

### Flow Steps
${spec.interactions.map((e, i) => `${i + 1}. ${describeInteraction(e)}`).join('\n')}

### API Endpoints
${spec.apiCalls.length
  ? spec.apiCalls
      .map(
        (c) =>
          `- ${c.method} ${c.url} → ${c.responseStatus}${
            c.requestBody ? `\n  Request: ${JSON.stringify(c.requestBody)}` : ''
          }`,
      )
      .join('\n')
  : 'No API calls captured.'}

### Full Specification (JSON)
\`\`\`json
${JSON.stringify(
  {
    metadata: spec.metadata,
    pages: spec.pages.map((p) => ({ url: p.url, title: p.title, components: p.components })),
    navigationFlow: spec.navigationFlow,
    apiCalls: spec.apiCalls,
    interactions: spec.interactions.slice(0, 50),
  },
  null,
  2,
)}
\`\`\`
`;
}

function inferTechStack(apiCalls: ApiCallSpec[]) {
  const hasGraphQL = apiCalls.some((c) => c.url.includes('graphql'));
  const hasRest = apiCalls.some((c) => c.url.includes('/api/'));
  return {
    backend: 'Node.js + Express',
    db: 'PostgreSQL',
    apiStyle: hasGraphQL ? 'GraphQL' : hasRest ? 'REST' : 'REST',
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function generateSpec(
  state: SessionState,
  endedAt: string,
  durationSeconds: number,
): JourneySpec {
  const pages = buildPageSpecs(state);
  const navFlow = enrichNavigationFlow(state.navigationFlow, state.interactions);

  const metadata: SessionMetadata = {
    journeyId: state.sessionId ?? uuidv4(),
    flowName: state.flowName,
    flowGoal: state.flowGoal,
    startedAt: state.startedAt ?? new Date().toISOString(),
    endedAt,
    durationSeconds,
    startUrl: state.lastUrl || (pages[0]?.url ?? ''),
    userAgent: navigator.userAgent,
    viewport: {
      width: 1920,
      height: 1080,
    },
    options: state.options,
  };

  const partial = {
    metadata,
    pages,
    interactions: state.interactions,
    navigationFlow: navFlow,
    apiCalls: state.apiCalls,
    screenshots: state.screenshots,
    userAnnotations: state.annotations,
  };

  const generatedMarkdown = renderMarkdown(partial);
  const aiSystemPrompt = renderAiPrompt(partial);

  return {
    ...partial,
    generatedMarkdown,
    aiSystemPrompt,
  };
}
