import type { Config } from '../config.js'
import type { ResearchModelConfig } from './model.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { OneShotSubagentDescriptorData } from '@deepseek-ai/dsh-subagent'

export interface ResearchSessionBootstrap {
  readonly id: string
  readonly parentId: string
  readonly descriptor: OneShotSubagentDescriptorData
}

/** One authenticated call owns one remote session; retries repeat the same seqs. */
export interface ResearchSessionBatch {
  readonly id: string
  readonly parentId: string
  readonly remoteId: string
  readonly createdAt: number
  readonly events: readonly SessionEvent[]
}

export interface ResearchBootstrap {
  readonly session?: ResearchSessionBootstrap
  readonly config: Config
  readonly model: ResearchModelConfig
  readonly softDeadline: number
  readonly hardDeadline: number
  readonly timeoutMs: number
  readonly finishMs: number
}

export const RESEARCH_RETRIEVAL_TOOLS = new Set(['web_search', 'docs_search', 'web_extract', 'search_sources', 'web_map'])
export const FINISH_NOTICE = 'web_research budget notice (time): the retrieval budget has ended. Do not search, extract, paginate or map again. Immediately call structured_output using only evidence already observed; retain supporting URLs/excerpts, distinguish summary_only from full_text, and list unverified or unfinished work in limitations. Use stop_reason=budget_exhausted. If no evidence was observed, use empty conclusions and explain why in limitations. Do not invent evidence. The hard deadline cannot be extended.'
