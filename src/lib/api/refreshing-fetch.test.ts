import type { CustomFetch, CustomFetchResponse } from '@todoist/sdk'
import { describe, expect, it, vi } from 'vitest'
import { createRefreshingFetch } from './refreshing-fetch.js'

function response(status: number): CustomFetchResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        headers: {},
        text: async () => '',
        json: async () => ({}),
    }
}

/** A fake API that accepts only `validToken`, recording the token each request carried. */
function fakeApi(validToken: { current: string }) {
    const sentTokens: string[] = []
    const fetch = vi.fn<CustomFetch>(async (_url, init) => {
        const auth = new Headers(init?.headers).get('Authorization')
        const token = auth?.replace(/^Bearer /, '') ?? ''
        sentTokens.push(token)
        return response(token === validToken.current ? 200 : 401)
    })
    return { fetch, sentTokens }
}

const REQUEST = {
    method: 'POST',
    headers: { Authorization: 'Bearer old-token', 'Content-Type': 'application/json' },
    body: '{"content":"Buy milk"}',
}

describe('createRefreshingFetch', () => {
    it('retries a refused request once with a rotated token, and sends that token afterwards', async () => {
        const valid = { current: 'new-token' }
        const api = fakeApi(valid)
        const refresh = vi.fn(async () => 'new-token')
        const fetch = createRefreshingFetch({
            fetch: api.fetch,
            token: 'old-token',
            refresh,
            onRefreshFailed: vi.fn(),
        })

        const first = await fetch('https://api.todoist.com/api/v1/tasks', REQUEST)
        const second = await fetch('https://api.todoist.com/api/v1/tasks', REQUEST)

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        // The refresh learns which token was refused, to spot one another
        // process has already replaced.
        expect(refresh).toHaveBeenCalledExactlyOnceWith('old-token')
        expect(api.sentTokens).toEqual(['old-token', 'new-token', 'new-token'])
        // The retry resends the same request, body and other headers included.
        expect(api.fetch.mock.calls[1]).toEqual([
            'https://api.todoist.com/api/v1/tasks',
            expect.objectContaining({ method: 'POST', body: '{"content":"Buy milk"}' }),
        ])
        expect(new Headers(api.fetch.mock.calls[1][1]?.headers).get('Content-Type')).toBe(
            'application/json',
        )
    })

    it('shares one refresh between requests refused at the same time', async () => {
        const valid = { current: 'new-token' }
        const api = fakeApi(valid)
        const refresh = vi.fn(async () => 'new-token')
        const fetch = createRefreshingFetch({
            fetch: api.fetch,
            token: 'old-token',
            refresh,
            onRefreshFailed: vi.fn(),
        })

        const results = await Promise.all([
            fetch('https://api.todoist.com/api/v1/tasks', REQUEST),
            fetch('https://api.todoist.com/api/v1/projects', REQUEST),
            fetch('https://api.todoist.com/api/v1/labels', REQUEST),
        ])

        expect(results.map((r) => r.status)).toEqual([200, 200, 200])
        expect(refresh).toHaveBeenCalledTimes(1)
    })

    it('returns the 401 and reports why when the refresh fails', async () => {
        const api = fakeApi({ current: 'never-issued' })
        const failure = new Error('Refresh token rejected: invalid_grant')
        const onRefreshFailed = vi.fn()
        const fetch = createRefreshingFetch({
            fetch: api.fetch,
            token: 'old-token',
            refresh: vi.fn(async () => {
                throw failure
            }),
            onRefreshFailed,
        })

        const result = await fetch('https://api.todoist.com/api/v1/tasks', REQUEST)

        expect(result.status).toBe(401)
        expect(onRefreshFailed).toHaveBeenCalledWith(failure)
        expect(api.sentTokens).toEqual(['old-token'])
    })

    it('does not try the refresh again for later requests once it has failed', async () => {
        const api = fakeApi({ current: 'never-issued' })
        const refresh = vi.fn(async () => {
            throw new Error('Refresh token rejected: invalid_grant')
        })
        const onRefreshFailed = vi.fn()
        const fetch = createRefreshingFetch({
            fetch: api.fetch,
            token: 'old-token',
            refresh,
            onRefreshFailed,
        })

        const first = await fetch('https://api.todoist.com/api/v1/tasks', REQUEST)
        const second = await fetch('https://api.todoist.com/api/v1/projects', REQUEST)

        expect([first.status, second.status]).toEqual([401, 401])
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(onRefreshFailed).toHaveBeenCalledTimes(1)
    })

    it('does not refresh again when the retry is refused too', async () => {
        const api = fakeApi({ current: 'never-issued' })
        const refresh = vi.fn(async () => 'new-token')
        const fetch = createRefreshingFetch({
            fetch: api.fetch,
            token: 'old-token',
            refresh,
            onRefreshFailed: vi.fn(),
        })

        const result = await fetch('https://api.todoist.com/api/v1/tasks', REQUEST)

        expect(result.status).toBe(401)
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(api.sentTokens).toEqual(['old-token', 'new-token'])
    })
})
