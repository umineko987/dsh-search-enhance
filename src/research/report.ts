import { valueSchemaSpecToJsonSchema, type ObjectJsonSchema, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

const evidence = z.strictObject({
  url: z.string().url().refine(value => /^https?:\/\//.test(value)),
  excerpt: z.string().trim().min(1),
  reading: z.enum(['full_text', 'summary_only']),
})
const report = z.strictObject({
  conclusions: z.array(z.strictObject({
    statement: z.string().trim().min(1),
    sources: z.array(evidence).min(1),
  })),
  limitations: z.array(z.string().trim().min(1)),
  stop_reason: z.enum(['completed', 'evidence_limited', 'budget_exhausted']),
}).refine(value => value.conclusions.length > 0 || value.limitations.length > 0,
  'A report must contain supported conclusions or explain why evidence is unavailable')
  .refine(value => value.stop_reason !== 'budget_exhausted' || value.limitations.length > 0,
    'A budget-exhausted report must explain unfinished work or evidence limitations')

export type ResearchReport = z.infer<typeof report>

export const RESEARCH_REPORT_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    conclusions: {
      type: 'array', required: true, description: 'Supported conclusions. Empty only when limitations explain unavailable evidence.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          statement: { type: 'string', required: true, description: 'Nonempty. Distinguish facts from inference.' },
          sources: {
            type: 'array', required: true, description: 'At least one source supporting THIS conclusion.',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                url: { type: 'string', required: true, description: 'Actual HTTP(S) source URL. Never a source_ref.' },
                excerpt: { type: 'string', required: true, description: 'Key source excerpt actually observed, nonempty.' },
                reading: { type: 'string', required: true, enum: ['full_text', 'summary_only'], description: 'full_text only after reading webpage body; snippets/summaries are summary_only.' },
              },
            },
          },
        },
      },
    },
    limitations: { type: 'array', required: true, items: { type: 'string' }, description: 'Unresolved questions, conflicts or evidence limitations. Required nonempty for budget_exhausted: explain remaining unverified/unfinished work or unavailable evidence.' },
    stop_reason: { type: 'string', required: true, enum: ['completed', 'evidence_limited', 'budget_exhausted'], description: 'budget_exhausted when the finish-only phase ends retrieval; completed or evidence_limited for earlier reports.' },
  },
} as const satisfies ValueSchemaSpec

export const RESEARCH_REPORT_SCHEMA = valueSchemaSpecToJsonSchema(RESEARCH_REPORT_OUTPUT_SCHEMA) as ObjectJsonSchema

export function validateResearchReport(value: unknown): ResearchReport {
  const parsed = report.safeParse(value)
  if (!parsed.success) throw new Error('web_research received a missing or invalid structured report')
  return parsed.data
}
