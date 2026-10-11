import { WEB_SEARCH_OUTPUT_BUDGET, type Config, type OutputBudget } from '../config.js'

/** Fixed Search API policy: infer source priorities from the query. */
export const SEARCH_PROMPT_BASE = `# Core Instruction

1. Infer the user's intent from the query, but do not broaden the task unless necessary.
2. Verify factual claims with authoritative sources before answering.
3. Prefer official documentation, academic databases, reputable media, and primary sources.
4. Cite sources at paragraph or table-row level. Do not cite every sentence.
5. Be concise and stay within the output budget.

# Output Style

1. Lead with the most probable answer or solution.
2. Use polished Markdown.
3. Define technical terms only when they are necessary for understanding.
4. State limitations when evidence is incomplete or conflicting.

Infer the best search strategy from the query.
If it is about programming, prefer official docs and GitHub.
If it is about academic or research material, prioritize papers, reports, and multi-source evidence.
If it is about factual claims, verify with independent sources.
Keep the result compact unless the query explicitly asks for depth.`

export interface ResolvedSearchStrategy {
  readonly budget: Readonly<OutputBudget>
  /** Provider collection cap, independent from the ordinary visible-source cap. */
  readonly maxCollectedSources: number
  readonly prompt: string
}

/** Fixed output limits; collection still follows the deployment retention bound. */
export function resolveSearchStrategy(config: Config): ResolvedSearchStrategy {
  const maxCollectedSources = config.retention.providerMaxSources
  if (!Number.isSafeInteger(maxCollectedSources) || maxCollectedSources <= 0) {
    throw new RangeError('providerMaxSources must be a positive safe integer')
  }
  return Object.freeze({
    budget: WEB_SEARCH_OUTPUT_BUDGET,
    maxCollectedSources,
    prompt: `${SEARCH_PROMPT_BASE}\n\n# Search Budget\n\nReturn a short answer, key evidence, and only the most relevant sources.\nKeep the answer under ${WEB_SEARCH_OUTPUT_BUDGET.maxAnswerCharacters} characters.\nReturn at most ${maxCollectedSources} source links in the final source/reference block.\n`,
  })
}
