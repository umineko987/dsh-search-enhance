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
  'search_tools',
] as const)

export const DEFERRED_TOOL_NAMES = Object.freeze(
  CAPABILITY_GROUPS.map(group => CAPABILITY_TOOL_NAMES[group]),
)

export function isCapabilityGroup(value: unknown): value is CapabilityGroup {
  return typeof value === 'string' && CAPABILITY_GROUPS.includes(value as CapabilityGroup)
}

/** Parse the closed loading request; removed capability groups are not accepted. */
export function parseSearchToolsArguments(value: unknown): readonly CapabilityGroup[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (Object.keys(value).some(key => key !== 'capabilities')) return undefined
  const capabilities = (value as { capabilities?: unknown }).capabilities
  if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > CAPABILITY_GROUPS.length) {
    return undefined
  }
  const groups: CapabilityGroup[] = []
  for (let index = 0; index < capabilities.length; index += 1) {
    if (!Object.hasOwn(capabilities, index) || !isCapabilityGroup(capabilities[index])) return undefined
    groups.push(capabilities[index])
  }
  return [...new Set(groups)]
}

export function orderCapabilityGroups(groups: Iterable<CapabilityGroup>): readonly CapabilityGroup[] {
  const selected = new Set(groups)
  return CAPABILITY_GROUPS.filter(group => selected.has(group))
}
