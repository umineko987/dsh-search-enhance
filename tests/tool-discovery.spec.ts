import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  validateJsonSchemaValue,
  valueSchemaSpecToJsonSchema,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import {
  CAPABILITY_GROUPS,
  DEFERRED_TOOL_NAMES,
  RESIDENT_TOOL_NAMES,
  foldToolDisclosureEvents,
  parseSearchToolsArguments,
} from '../src/tool-discovery/index.js'
import {
  SEARCH_TOOLS_OUTPUT_SCHEMA,
  SEARCH_TOOLS_PARAMETERS,
  createSearchToolsTool,
} from '../src/tools/search-tools.js'

function runContext(args: unknown, agent: Agent | undefined = {} as Agent): ToolRunContext {
  return {
    callId: ToolCallId('load'), rootCallId: ToolCallId('load'), name: 'search_tools', arguments: args,
    ...(agent === undefined ? {} : { agent }),
    token: Symbol('load') as never, signal: new AbortController().signal,
    deferContext() {}, concludeTurn() {},
  }
}

function nativeHistory(options: {
  args?: unknown; name?: string; isError?: boolean; complete?: boolean
} = {}): Session {
  const session = Session.create(SessionId('loading-history'))
  session.append('step/start', { turn: 1, step: 1 })
  const call = session.append('tool/call', {
    turn: 1, step: 1, callId: ToolCallId('load'), name: options.name ?? 'search_tools',
    arguments: JSON.stringify(options.args ?? { capabilities: ['site_map'] }),
  })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('load'), content: [{ type: 'text', text: 'not parsed for recovery' }],
      isError: options.isError ?? false,
    }),
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  if (options.complete !== false) session.append('step/end', { turn: 1, step: 1 })
  return session
}

function codeHistory(isError: boolean): Session {
  const session = Session.create(SessionId('code-loading-history'))
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/ptc-dispatch', {
    rootCallId: ToolCallId('code'), parentCallId: ToolCallId('code'), subCallId: ToolCallId('code:ptc:1'),
    name: 'search_tools', arguments: { capabilities: ['sources', 'site_map'] }, isError, content: [],
  })
  session.append('step/end', { turn: 1, step: 1 })
  return session
}

describe('lightweight real-tool loading', () => {
  it('keeps only the approved resident tools and optional capabilities', () => {
    expect(RESIDENT_TOOL_NAMES).toEqual(['web_search', 'docs_search', 'web_extract', 'search_tools'])
    expect(CAPABILITY_GROUPS).toEqual(['sources', 'site_map'])
    expect(DEFERRED_TOOL_NAMES).toEqual(['search_sources', 'web_map'])
    expect(SEARCH_TOOLS_PARAMETERS.additionalProperties).toBe(false)
  })

  it.each([
    {}, { capabilities: [] }, { capabilities: ['sources', 'site_map', 'sources'] },
    { capabilities: ['context7'] }, { capabilities: ['planning'] }, { capabilities: ['diagnostics'] },
    { capabilities: ['sources'], operation: 'search_sources' }, { capabilities: new Array(1) },
  ])('rejects malformed and removed requests: %j', args => {
    expect(parseSearchToolsArguments(args)).toBeUndefined()
  })

  it('returns compact tool names, not manifests or a gateway, and is idempotent', async () => {
    const activeGroups = vi.fn(() => ['sources'] as const)
    const tool = createSearchToolsTool({ activeGroups })
    const args = { capabilities: ['site_map', 'sources'] }
    const value = await tool.execute(args, runContext(args))
    expect(value).toEqual({
      requested_groups: ['site_map', 'sources'], added_groups: ['site_map'],
      active_groups: ['sources', 'site_map'], tools: ['web_map', 'search_sources'], takes_effect: 'next_step',
    })
    expect(validateJsonSchemaValue(valueSchemaSpecToJsonSchema(SEARCH_TOOLS_OUTPUT_SCHEMA), value)).toEqual([])
    expect(JSON.stringify(value)).not.toMatch(/parameters|operations|search_call|gateway/)
    const again = await tool.execute({ capabilities: ['sources', 'sources'] }, runContext({}))
    expect(again).toMatchObject({ requested_groups: ['sources'], added_groups: [], takes_effect: 'already_active' })
    await expect(tool.execute({ capabilities: ['context7'] }, runContext({}))).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    const withoutAgent = runContext({})
    delete (withoutAgent as { agent?: Agent }).agent
    await expect(tool.execute(args, withoutAgent)).rejects.toThrow(/live Agent/)
  })

  it('loads successful Native requests only after step/end and recovers without parsing text', () => {
    const session = nativeHistory({ complete: false })
    expect(foldToolDisclosureEvents(session.snapshotEvents()).activeGroups).toEqual([])
    session.append('step/end', { turn: 1, step: 1 })
    expect(foldToolDisclosureEvents(session.snapshotEvents()).activeGroups).toEqual(['site_map'])
    expect(foldToolDisclosureEvents(nativeHistory({ isError: true }).snapshotEvents()).activeGroups).toEqual([])
    const unpaired = session.snapshotEvents().filter(event => event.type !== 'tool/call')
    expect(foldToolDisclosureEvents(unpaired).activeGroups).toEqual([])
  })

  it('does not carry interrupted requests into later steps', () => {
    const session = nativeHistory({ complete: false })
    session.append('step/start', { turn: 2, step: 1 })
    session.append('step/end', { turn: 2, step: 1 })
    expect(foldToolDisclosureEvents(session.snapshotEvents()).activeGroups).toEqual([])
  })

  it('recovers successful Code loading from standard dispatch events and ignores errors', () => {
    expect(foldToolDisclosureEvents(codeHistory(false).snapshotEvents()).activeGroups).toEqual(['sources', 'site_map'])
    expect(foldToolDisclosureEvents(codeHistory(true).snapshotEvents()).activeGroups).toEqual([])
  })

  it('does not auto-load pagination from search results or restore removed capabilities', () => {
    for (const name of ['web_search', 'docs_search']) {
      expect(foldToolDisclosureEvents(nativeHistory({ name, args: { query: 'source' } }).snapshotEvents()).activeGroups).toEqual([])
    }
    expect(foldToolDisclosureEvents(nativeHistory({ args: { capabilities: ['planning'] } }).snapshotEvents()).activeGroups).toEqual([])
  })
})
