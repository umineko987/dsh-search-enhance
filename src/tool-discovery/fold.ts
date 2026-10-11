import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools/types'

import type { SourceCallIdentity } from '../contracts/index.js'
import { isSourceResultTool, type CapabilityGroup } from './capabilities.js'

interface StepPosition {
  readonly turn: number
  readonly step: number
}

interface PendingPtcCall {
  readonly call: SourceCallIdentity
  readonly parentCallId: string
  readonly arguments: unknown
}

export type SourceCallReader = (call: SourceCallIdentity) => boolean

export interface ToolDisclosureFoldState {
  readonly activeGroups: readonly CapabilityGroup[]
  readonly pendingSources: readonly SourceCallIdentity[]
  readonly pendingNativeCalls: ReadonlyMap<string, string>
  readonly pendingPtcCalls: ReadonlyMap<string, PendingPtcCall>
  readonly step?: StepPosition
}

export function createToolDisclosureFoldState(
  activeGroups: readonly CapabilityGroup[] = [],
): ToolDisclosureFoldState {
  return { activeGroups, pendingSources: [], pendingNativeCalls: new Map(), pendingPtcCalls: new Map() }
}

function sameStep(state: ToolDisclosureFoldState, position: StepPosition): boolean {
  return state.step?.turn === position.turn && state.step.step === position.step
}

/** Only paired structured successes with readable sources enable pagination, at step/end. */
export function foldToolDisclosureEvent(
  state: ToolDisclosureFoldState,
  event: SessionEvent,
  canReadSourceCall: SourceCallReader = () => false,
): ToolDisclosureFoldState {
  if (event.type === 'step/start') {
    return { ...createToolDisclosureFoldState(state.activeGroups), step: event.data }
  }
  if (event.type === 'step/end') {
    if (!sameStep(state, event.data)) return state
    return createToolDisclosureFoldState(
      state.activeGroups.includes('sources') || state.pendingSources.some(canReadSourceCall) ? ['sources'] : [],
    )
  }
  if (event.type === 'turn/end') return createToolDisclosureFoldState(state.activeGroups)

  if (event.type === 'tool/call') {
    if (!sameStep(state, event.data)
      || (!isSourceResultTool(event.data.name) && event.data.name !== 'run_code')
      || state.pendingNativeCalls.has(event.data.callId)) return state
    const pendingNativeCalls = new Map(state.pendingNativeCalls)
    pendingNativeCalls.set(event.data.callId, event.data.name)
    return { ...state, pendingNativeCalls }
  }
  if (event.type === 'tool/result') {
    if (!sameStep(state, event.data)) return state
    const callId = event.data.message.toolCallId
    const name = state.pendingNativeCalls.get(callId)
    if (name === undefined) return state
    const pendingNativeCalls = new Map(state.pendingNativeCalls)
    pendingNativeCalls.delete(callId)
    const call: SourceCallIdentity = { mode: 'top-level', rootCallId: callId, callId, name }
    const meta = event.data.meta
    const sourceNotProduced = meta !== null && typeof meta === 'object' && !Array.isArray(meta)
      && meta.source_produced === false
    const readable = isSourceResultTool(name) && !event.data.message.isError
      && event.data.error === undefined && !sourceNotProduced && canReadSourceCall(call)
    return {
      ...state, pendingNativeCalls,
      pendingSources: readable ? [...state.pendingSources, call] : state.pendingSources,
    }
  }
  if (event.type === 'tool/ptc-dispatch-start') {
    const data = event.data
    if (state.step === undefined || !isSourceResultTool(data.name)
      || state.pendingNativeCalls.get(data.rootCallId) !== 'run_code'
      || state.pendingPtcCalls.has(data.subCallId)) return state
    const pendingPtcCalls = new Map(state.pendingPtcCalls)
    pendingPtcCalls.set(data.subCallId, {
      parentCallId: data.parentCallId,
      arguments: data.arguments,
      call: { mode: 'nested-code', rootCallId: data.rootCallId, callId: data.subCallId, name: data.name },
    })
    return { ...state, pendingPtcCalls }
  }
  if (event.type === 'tool/ptc-dispatch') {
    const data = event.data
    const pending = state.pendingPtcCalls.get(data.subCallId)
    if (state.step === undefined || pending === undefined) return state
    const pendingPtcCalls = new Map(state.pendingPtcCalls)
    pendingPtcCalls.delete(data.subCallId)
    const readable = pending.call.rootCallId === data.rootCallId
      && pending.parentCallId === data.parentCallId && pending.call.name === data.name
      && JSON.stringify(pending.arguments) === JSON.stringify(data.arguments)
      && !data.isError && data.error === undefined && canReadSourceCall(pending.call)
    return {
      ...state, pendingPtcCalls,
      pendingSources: readable ? [...state.pendingSources, pending.call] : state.pendingSources,
    }
  }
  return state
}

/** Replay only standard structured events, consulting the existing source store by call identity. */
export function foldToolDisclosureEvents(
  events: readonly SessionEvent[],
  canReadSourceCall: SourceCallReader = () => false,
): ToolDisclosureFoldState {
  return events.reduce((state, event) => foldToolDisclosureEvent(state, event, canReadSourceCall), createToolDisclosureFoldState())
}
