import { CliError as BaseCliError } from '@todoist/cli-core'
import type { CustomFetch } from '@todoist/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../../test-support/json-response.js'
import type { ResolvedUser } from '../auth.js'

const mocks = vi.hoisted(() => ({
    resolveActiveUser: vi.fn(),
    replaceRejectedToken: vi.fn(),
    fetch: vi.fn(),
}))

vi.mock('../auth.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../auth.js')>()),
    resolveActiveUser: mocks.resolveActiveUser,
}))

// The refresh grant and its lock; `src/lib/auth.test.ts` runs them for real.
vi.mock('../auth-refresh.js', () => ({ replaceRejectedToken: mocks.replaceRejectedToken }))

// The HTTP boundary: every SDK request goes through this fetch.
vi.mock('../usage-tracking.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../usage-tracking.js')>()),
    createTrackedFetch: () => mocks.fetch,
}))

/** An API that only accepts `validToken`. */
function acceptOnly(validToken: string): void {
    mocks.fetch.mockImplementation((async (_url, init) => {
        const auth = new Headers(init?.headers).get('Authorization')
        return auth === `Bearer ${validToken}`
            ? jsonResponse(200, { results: [], next_cursor: null })
            : jsonResponse(401, { error: 'Unauthorized' })
    }) satisfies CustomFetch)
}

function storedUser(canRefresh: boolean): ResolvedUser {
    return {
        id: '111',
        email: 'person@example.com',
        token: 'old-token',
        authMode: 'read-write',
        source: 'secure-store',
        canRefresh,
    }
}

describe('getApi with an expiring OAuth token', () => {
    beforeEach(() => {
        // getApi caches its client per module instance.
        vi.resetModules()
        vi.clearAllMocks()
    })

    it('retries a request refused with a 401 using a refreshed token', async () => {
        mocks.resolveActiveUser.mockResolvedValue(storedUser(true))
        mocks.replaceRejectedToken.mockResolvedValue('new-token')
        acceptOnly('new-token')

        const { getApi } = await import('./core.js')
        const api = await getApi()

        await expect(api.getLabels()).resolves.toEqual({ results: [], nextCursor: null })
        expect(mocks.replaceRejectedToken).toHaveBeenCalledWith('111', 'old-token')
    })

    it('reports why the refresh failed when the 401 cannot be retried', async () => {
        mocks.resolveActiveUser.mockResolvedValue(storedUser(true))
        mocks.replaceRejectedToken.mockRejectedValue(
            new BaseCliError('AUTH_REFRESH_EXPIRED', 'Refresh token rejected: invalid_grant', {
                hints: ['Re-run the login command to reauthorize.'],
            }),
        )
        acceptOnly('never-issued')

        const { getApi } = await import('./core.js')
        const api = await getApi()

        // Still AUTH_ERROR, so callers that classify a refused request by code
        // (`task add-many`) keep working; the message and hint say why.
        await expect(api.getLabels()).rejects.toMatchObject({
            code: 'AUTH_ERROR',
            message: 'Refresh token rejected: invalid_grant',
            hints: ['Run: td auth login'],
        })
    })

    it('never refreshes for an account without a refresh token', async () => {
        mocks.resolveActiveUser.mockResolvedValue(storedUser(false))
        acceptOnly('never-issued')

        const { getApi } = await import('./core.js')
        const api = await getApi()

        await expect(api.getLabels()).rejects.toMatchObject({ code: 'AUTH_ERROR' })
        expect(mocks.replaceRejectedToken).not.toHaveBeenCalled()
        expect(mocks.fetch).toHaveBeenCalledTimes(1)
    })
})
