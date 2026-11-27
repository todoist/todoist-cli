import type { CustomFetchResponse } from '@todoist/sdk'

/** A JSON reply for tests that run the real SDK and stub only its transport (`customFetch`). */
export function jsonResponse(status: number, body: unknown): CustomFetchResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 401 ? 'Unauthorized' : 'OK',
        headers: { 'content-type': 'application/json' },
        text: async () => JSON.stringify(body),
        json: async () => body,
    }
}
