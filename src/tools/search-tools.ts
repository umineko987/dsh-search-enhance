import {
  ToolArgsError,
  defineTool,
  parameterSchemaSpecToJsonSchema,
  type ToolDefinition,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'

import {
  CAPABILITY_GROUPS,
  CAPABILITY_TOOL_NAMES,
  DEFERRED_TOOL_NAMES,
  orderCapabilityGroups,
  parseSearchToolsArguments,
} from '../tool-discovery/capabilities.js'
import type { AgentToolDisclosureManager } from '../tool-discovery/manager.js'
import { throwIfAborted } from '../provider-runtime/index.js'

const SEARCH_TOOLS_PARAMETER_SPEC = {
  capabilities: {
    type: 'array',
    items: { type: 'string', enum: CAPABILITY_GROUPS },
    required: true,
    description: 'Select sources (source pagination), site_map (website URL discovery), or both.',
  },
} as const

export const SEARCH_TOOLS_PARAMETERS = Object.freeze({
  ...parameterSchemaSpecToJsonSchema(SEARCH_TOOLS_PARAMETER_SPEC),
  additionalProperties: false,
})

const groupList = { type: 'array', items: { type: 'string', enum: CAPABILITY_GROUPS }, required: true } as const

export const SEARCH_TOOLS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    requested_groups: groupList,
    added_groups: groupList,
    active_groups: groupList,
    tools: { type: 'array', items: { type: 'string', enum: DEFERRED_TOOL_NAMES }, required: true },
    takes_effect: { type: 'string', enum: ['already_active', 'next_step'], required: true },
  },
  additionalProperties: false,
} as const satisfies ValueSchemaSpec

/** Select real tools for the next step; DSH owns their schema, validation, execution, and presentation. */
export function createSearchToolsTool(disclosure: Pick<AgentToolDisclosureManager, 'activeGroups'>): ToolDefinition {
  const definition = defineTool({
    name: 'search_tools',
    description: 'Load optional real search tools for this Agent: sources loads search_sources, site_map loads web_map. Use only when needed. Newly loaded tools appear on the next model step; call them directly using their tool definitions. Already loaded tools stay available.',
    parameters: SEARCH_TOOLS_PARAMETER_SPEC,
    output: {
      schema: SEARCH_TOOLS_OUTPUT_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: `${value.tools.join(', ')}: ${value.takes_effect === 'next_step' ? 'available from the next model step' : 'already available'}. Call these tools directly.`,
      }],
    },
    async execute(args, exec) {
      throwIfAborted(exec.signal)
      if (exec.agent === undefined) throw new Error('search_tools requires a live Agent session')
      const requested = parseSearchToolsArguments(args)
      if (requested === undefined) throw new ToolArgsError(['"capabilities" must contain 1-2 values from sources/site_map, with no extra fields'])
      const activeBefore = disclosure.activeGroups(exec.agent)
      const added = requested.filter(group => !activeBefore.includes(group))
      return {
        requested_groups: [...requested],
        added_groups: added,
        active_groups: [...orderCapabilityGroups([...activeBefore, ...requested])],
        tools: requested.map(group => CAPABILITY_TOOL_NAMES[group]),
        takes_effect: added.length === 0 ? 'already_active' as const : 'next_step' as const,
      }
    },
    presentCall: () => ({ card: 'generic', kind: 'search', title: 'Load optional search tools' }),
    presentResult: (_args, result) => ({
      card: 'generic', title: result.isError ? 'Search tool loading failed' : 'Search tools selected',
    }),
  })
  return Object.freeze({ ...definition, parameters: SEARCH_TOOLS_PARAMETERS })
}
