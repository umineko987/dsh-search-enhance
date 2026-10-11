export const CAPABILITY_GROUPS = Object.freeze(['sources', 'site_map'] as const)
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number]

export const CAPABILITY_TOOL_NAMES = Object.freeze({
  sources: 'search_sources',
  site_map: 'web_map',
} as const)

export const RESIDENT_TOOL_NAMES = Object.freeze([
  'web_search',
  'docs_search',
  'web_extract',
  'web_research',
] as const)

export const DEFERRED_TOOL_NAMES = Object.freeze(
  CAPABILITY_GROUPS.map(group => CAPABILITY_TOOL_NAMES[group]),
)

export const RESEARCH_TOOL_NAMES = Object.freeze([
  'web_search',
  'docs_search',
  'web_extract',
  'search_sources',
  'web_map',
] as const)

export const SOURCE_RESULT_TOOL_NAMES = Object.freeze(['web_search', 'docs_search', 'web_research'] as const)

export function isSourceResultTool(name: string): boolean {
  return SOURCE_RESULT_TOOL_NAMES.some(candidate => candidate === name)
}
