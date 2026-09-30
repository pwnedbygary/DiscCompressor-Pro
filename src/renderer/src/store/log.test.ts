import { beforeEach, describe, expect, it } from 'vitest'
import { log, unseenLevel, useLog } from './log'

beforeEach(() => {
  useLog.setState({ entries: [], seenId: 0 })
})

describe('unseenLevel', () => {
  it('reports the worst warning or error logged after the newest seen entry', () => {
    expect(unseenLevel(useLog.getState())).toBeNull()
    log('info', 'Added 2 images')
    log('success', 'Done')
    expect(unseenLevel(useLog.getState())).toBeNull()
    log('warn', 'The CDI image stores subchannel data, which is not kept')
    expect(unseenLevel(useLog.getState())).toBe('warn')
    log('error', 'chdman failed')
    log('info', 'Queue finished')
    expect(unseenLevel(useLog.getState())).toBe('error')
  })

  it('forgets what was logged before the console showed it', () => {
    log('error', 'chdman failed')
    useLog.getState().markSeen()
    expect(unseenLevel(useLog.getState())).toBeNull()
    log('warn', 'Skipped a.iso: Not a supported disc image')
    expect(unseenLevel(useLog.getState())).toBe('warn')
  })

  it('stays clear when the console is cleared, and marks later entries', () => {
    log('warn', 'Skipped a.iso')
    useLog.getState().clear()
    expect(unseenLevel(useLog.getState())).toBeNull()
    useLog.getState().markSeen()
    log('error', 'chdman failed')
    expect(unseenLevel(useLog.getState())).toBe('error')
  })
})

describe('markSeen', () => {
  it('does not notify listeners when nothing new was logged', () => {
    log('info', 'Added 1 image')
    useLog.getState().markSeen()
    let notified = 0
    const stop = useLog.subscribe(() => (notified += 1))
    useLog.getState().markSeen()
    stop()
    expect(notified).toBe(0)
  })
})
