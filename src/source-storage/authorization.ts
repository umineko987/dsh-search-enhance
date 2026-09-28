import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

import type { StoredSourceRecord } from '../contracts/index.js'

function successfulTopLevelResult(event: SessionEvent, callId: string): boolean {
  if (event.type !== 'tool/result') return false
  if (event.data.error !== undefined) return false
  return event.data.message.toolCallId === callId
    && event.data.message.isError !== true
}

function successfulCodeDispatch(
  event: SessionEvent,
  record: StoredSourceRecord,
): boolean {
  if (event.type !== 'tool/ptc-dispatch') return false
  const data = event.data
  return data.isError === false
    && data.rootCallId === record.call.rootCallId
    && data.subCallId === record.call.callId
    && data.name === record.call.name
}

function inheritedEvents(session: Session): readonly SessionEvent[] {
  if (session.header.parentSession === undefined) return []
  return session.snapshotEvents(undefined, session.inheritedEventCount)
}

/** Authorize the owner immediately, or a fork only through inherited structured success events. */
export function canReadSourceRecord(session: Session, record: StoredSourceRecord): boolean {
  if (String(session.id) === record.ownerSessionId) return true
  const events = inheritedEvents(session)
  if (record.call.mode === 'top-level') {
    return events.some(event => successfulTopLevelResult(event, record.call.callId))
  }
  return events.some(event => successfulCodeDispatch(event, record))
}
