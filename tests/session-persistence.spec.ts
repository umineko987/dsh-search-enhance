import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'

describe('official session persistence compatibility guard', () => {
  it('refuses an unknown required event instead of silently reconstructing it', () => {
    const header = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('unknown-required-event-fixture'),
      createdAt: 0,
      isSeeded: false,
    } as const
    const events = [{
      type: 'search-enhance/unknown-required-fixture',
      seq: SessionSeq(0),
      time: 0,
      data: {},
    } as unknown as SessionEvent]
    const validate = () => validateStoredEvents(header, events)
    expect(validate).toThrow(SessionFormatUnsupportedError)
    expect(validate).toThrow(/unknown|required|event type/i)
  })
})
