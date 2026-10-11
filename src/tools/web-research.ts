import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { ResearchExecutor } from '../research/executor.js'
import { RESEARCH_REPORT_OUTPUT_SCHEMA } from '../research/report.js'
import type { ForegroundOperationScope } from './operations.js'

export interface WebResearchToolDependencies {
  readonly research: Pick<ResearchExecutor, 'run'>
  readonly operations: ForegroundOperationScope
}

export function createWebResearchTool(dependencies: WebResearchToolDependencies): ToolDefinition {
  return defineTool({
    name: 'web_research',
    description: 'Delegate multi-step web research to an isolated specialist and wait for a structured report with supporting URLs, excerpts, evidence limitations and an honest stop_reason. Budget-limited partial reports use budget_exhausted; cancellation or hard exhaustion without a valid report fails. The query must include the complete task and all constraints; the specialist cannot see this conversation.',
    parameters: {
      query: { type: 'string', required: true, description: 'Self-contained research question, including task, scope and constraints.' },
      timeout_ms: { type: 'integer', description: 'Total time budget in milliseconds including startup, chosen for this call. Optional; defaults to 600000 (10 minutes). Must be 60000–3600000 (1–60 minutes); invalid values fail, not clamp. The specialist cannot extend this budget.' },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: RESEARCH_REPORT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('web_research requires a live Agent')
      if (args.query.trim().length === 0) throw new Error('web_research query must not be empty')
      return dependencies.operations.run(exec.signal, signal => dependencies.research.run({
        query: args.query, ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }), parent, signal,
      }), parent)
    },
  })
}
