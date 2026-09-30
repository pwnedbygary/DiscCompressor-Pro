import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '@shared/types'
import { useToasts } from './toasts'
import { useUpdates, watchUpdates } from './updates'

const env = vi.hoisted(() => {
  const env = {
    listener: null as ((status: unknown) => void) | null,
    answer: (_status: unknown): void => undefined,
    api: {
      onUpdateStatus: vi.fn((listener: (status: unknown) => void) => {
        env.listener = listener
        return () => {
          env.listener = null
        }
      }),
      getUpdateStatus: vi.fn(
        () =>
          new Promise((resolve) => {
            env.answer = resolve
          })
      ),
      installUpdate: vi.fn(() => Promise.resolve())
    }
  }
  vi.stubGlobal('window', { api: env.api })
  return env
})

const status = (state: UpdateStatus['state'], version: string | null = null): UpdateStatus => ({
  support: 'install',
  state,
  version,
  progress: null,
  error: null,
  failed: null,
  checkedAt: null
})

afterEach(() => {
  useUpdates.setState({ status: null })
  useToasts.setState({ toasts: [] })
})

describe('watchUpdates', () => {
  it('keeps a status pushed while the first one was being read, which is newer', async () => {
    const stop = watchUpdates()
    env.listener?.(status('available', '2.4.0'))
    env.answer(status('idle'))
    await Promise.resolve()
    expect(useUpdates.getState().status).toEqual(status('available', '2.4.0'))
    stop()
    expect(env.listener).toBeNull()
  })

  it('takes the status it read when nothing was pushed', async () => {
    watchUpdates()
    env.answer(status('up-to-date'))
    await Promise.resolve()
    expect(useUpdates.getState().status).toEqual(status('up-to-date'))
  })
})

describe('installing', () => {
  it('shows why the app cannot restart yet', async () => {
    env.api.installUpdate.mockRejectedValueOnce(new Error("Error invoking remote method 'updates:install': Error: Wait for the queue to finish, or stop it, before restarting"))
    await useUpdates.getState().install()
    expect(useToasts.getState().toasts).toMatchObject([{ kind: 'error', title: 'Could not install the update', detail: 'Wait for the queue to finish, or stop it, before restarting' }])
  })
})
