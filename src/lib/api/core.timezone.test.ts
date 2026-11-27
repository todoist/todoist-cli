import type { CustomFetch } from '@todoist/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../../test-support/json-response.js'
import { rawUser } from '../../test-support/raw-user.js'

const mocks = vi.hoisted(() => ({
    resolveActiveUser: vi.fn(),
    fetch: vi.fn(),
}))

vi.mock('../auth.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../auth.js')>()),
    resolveActiveUser: mocks.resolveActiveUser,
}))

// The HTTP boundary: every SDK request goes through this fetch.
vi.mock('../usage-tracking.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../usage-tracking.js')>()),
    createTrackedFetch: () => mocks.fetch,
}))

/** The account's `GET /user` answers with `timezone` as its time zone. */
function accountIn(timezone: string): void {
    const body = rawUser({
        tz_info: { timezone, hours: 0, minutes: 0, is_dst: 0, gmt_string: '+00:00' },
    })
    mocks.fetch.mockImplementation((async () => jsonResponse(200, body)) satisfies CustomFetch)
}

describe('getAccountTimezone', () => {
    beforeEach(() => {
        // core.ts caches the account and its time zone per module instance.
        vi.resetModules()
        vi.clearAllMocks()
        mocks.resolveActiveUser.mockResolvedValue({
            id: '111',
            email: 'person@example.com',
            token: 'token',
            authMode: 'read-write',
            source: 'secure-store',
            canRefresh: false,
        })
    })

    it.each([
        ['an IANA name as it is', 'America/Chicago', 'America/Chicago'],
        ['GMT on its own as it is', 'GMT', 'GMT'],
        ['a fixed offset west of UTC as an offset', 'GMT -6:00', '-06:00'],
        ['a fixed offset with minutes as an offset', 'GMT +5:30', '+05:30'],
        ['a two-digit fixed offset as an offset', 'GMT +10:00', '+10:00'],
    ])('returns %s', async (_, accountTimezone, expected) => {
        accountIn(accountTimezone)
        const { getAccountTimezone } = await import('./core.js')

        await expect(getAccountTimezone()).resolves.toBe(expected)
    })
})
