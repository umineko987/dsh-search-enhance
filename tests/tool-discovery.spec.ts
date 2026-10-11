import { ToolCallId, createToolResultMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'

import {
  RESIDENT_TOOL_NAMES,
  RESEARCH_TOOL_NAMES,
  foldToolDisclosureEvents,
} from '../src/tool-discovery/index.js'

function nativeHistory(options: {
  name?: string; isError?: boolean; complete?: boolean; matched?: boolean; meta?: { source_produced: boolean }
} = {}): Session {
  const session = Session.create(SessionId('source-history'))
  session.append('step/start', { turn: 1, step: 1 })
  const call = session.append('tool/call', {
    turn: 1, step: 1, callId: ToolCallId('search'), name: options.name ?? 'web_search',
    arguments: JSON.stringify({ query: 'source' }),
  })
  session.append('tool/result', {
    turn: 1, step: 1,
    ...(options.meta === undefined ? {} : { meta: options.meta }),
    message: createToolResultMessage({
      callId: ToolCallId(options.matched === false ? 'other-call' : 'search'),
      content: [{ type: 'text', text: 'source_ref: src_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
      isError: options.isError ?? false,
    }),
  }, { sourceEventSeqs: [call.seq], surfaceOp: 'append' })
  if (options.complete !== false) session.append('step/end', { turn: 1, step: 1 })
  return session
}

function codeHistory(options: {
  isError?: boolean; complete?: boolean; start?: boolean; root?: boolean;
  mismatch?: 'root' | 'parent' | 'name' | 'arguments' | 'subcall'
} = {}): Session {
  const session = Session.create(SessionId('code-source-history'))
  session.append('step/start', { turn: 1, step: 1 })
  if (options.root !== false) session.append('tool/call', {
    turn: 1, step: 1, callId: ToolCallId('code'), name: 'run_code', arguments: '{}',
  })
  const dispatch = {
    rootCallId: ToolCallId('code'), parentCallId: ToolCallId('code'), subCallId: ToolCallId('code:ptc:1'),
    name: 'docs_search', arguments: { query: 'source' },
  }
  if (options.start !== false) session.append('tool/ptc-dispatch-start', dispatch)
  session.append('tool/ptc-dispatch', {
    ...dispatch, isError: options.isError ?? false, content: [],
    ...(options.mismatch === 'root' ? { rootCallId: ToolCallId('other-root') } : {}),
    ...(options.mismatch === 'parent' ? { parentCallId: ToolCallId('other-parent') } : {}),
    ...(options.mismatch === 'subcall' ? { subCallId: ToolCallId('other-subcall') } : {}),
    ...(options.mismatch === 'name' ? { name: 'web_search' } : {}),
    ...(options.mismatch === 'arguments' ? { arguments: { query: 'different' } } : {}),
  })
  if (options.complete !== false) session.append('step/end', { turn: 1, step: 1 })
  return session
}

const readable = () => true

function groups(session: Session, reader = readable) {
  return foldToolDisclosureEvents(session.snapshotEvents(), reader).activeGroups
}

describe('role tools and structured source disclosure folding', () => {
  it('defines the approved closed main and research sets without search_tools', () => {
    expect(RESIDENT_TOOL_NAMES).toEqual(['web_search', 'docs_search', 'web_extract', 'web_research'])
    expect(RESEARCH_TOOL_NAMES).toEqual(['web_search', 'docs_search', 'web_extract', 'search_sources', 'web_map'])
  })

  it.each(['web_search', 'docs_search', 'web_research'])('loads pagination from readable %s success only after step/end', name => {
    const session = nativeHistory({ name, complete: false })
    expect(groups(session)).toEqual([])
    session.append('step/end', { turn: 1, step: 1 })
    expect(groups(session)).toEqual(['sources'])
  })

  it.each([
    { isError: true }, { matched: false }, { meta: { source_produced: false } },
    { name: 'search_tools' }, { name: 'web_map' }, { name: 'unrelated' },
  ])('ignores failed, unmatched and old loading calls: %j', options => {
    expect(groups(nativeHistory(options))).toEqual([])
  })

  it('requires a readable source lookup and never parses result or assistant prose', () => {
    const session = nativeHistory()
    session.append('assistant/message', {
      turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text: 'Successfully loaded search_sources and web_map' }] }), stream: [],
    }, { surfaceOp: 'append' })
    expect(groups(session, () => false)).toEqual([])
    expect(foldToolDisclosureEvents(session.snapshotEvents()).activeGroups).toEqual([])
  })

  it('requires the native call event, not just a success result', () => {
    expect(foldToolDisclosureEvents(nativeHistory().snapshotEvents().filter(event => event.type !== 'tool/call'), readable).activeGroups).toEqual([])
  })

  it.each(['step/start', 'turn/end'] as const)('does not carry interrupted successes past %s', boundary => {
    const session = nativeHistory({ complete: false })
    if (boundary === 'step/start') session.append(boundary, { turn: 2, step: 1 })
    else {
      session.append(boundary, { turn: 1, reason: { kind: 'completed' } })
      session.append('step/start', { turn: 2, step: 1 })
    }
    session.append('step/end', { turn: 2, step: 1 })
    expect(groups(session)).toEqual([])
  })

  it('ignores a mismatched step boundary and rechecks readability at the correct boundary', () => {
    const session = nativeHistory({ complete: false })
    session.append('step/end', { turn: 1, step: 2 })
    expect(groups(session)).toEqual([])
    session.append('step/end', { turn: 1, step: 1 })
    const reader = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    expect(groups(session, reader)).toEqual([])
  })

  it('passes the complete Native call identity to the private source lookup', () => {
    const reader = vi.fn(readable)
    expect(groups(nativeHistory(), reader)).toEqual(['sources'])
    expect(reader).toHaveBeenCalledWith({ mode: 'top-level', rootCallId: 'search', callId: 'search', name: 'web_search' })
  })

  it('pairs real PTC starts and settlements and waits for step/end', () => {
    const session = codeHistory({ complete: false })
    expect(groups(session)).toEqual([])
    session.append('step/end', { turn: 1, step: 1 })
    const reader = vi.fn(readable)
    expect(groups(session, reader)).toEqual(['sources'])
    expect(reader).toHaveBeenCalledWith({ mode: 'nested-code', rootCallId: 'code', callId: 'code:ptc:1', name: 'docs_search' })
  })

  it.each([
    { isError: true }, { start: false }, { root: false },
    ...(['root', 'parent', 'name', 'arguments', 'subcall'] as const).map(mismatch => ({ mismatch })),
  ])('rejects failed or unpaired PTC outcomes: %j', options => {
    expect(groups(codeHistory(options))).toEqual([])
  })

  it('keeps successful disclosure active across subsequent empty steps', () => {
    const session = nativeHistory()
    session.append('step/start', { turn: 1, step: 2 })
    session.append('step/end', { turn: 1, step: 2 })
    expect(groups(session)).toEqual(['sources'])
  })
})
