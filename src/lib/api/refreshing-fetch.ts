import type { CustomFetch } from '@todoist/sdk'

type FetchInit = Parameters<CustomFetch>[1]

type RefreshingFetchOptions = {
    /** The fetch that sends each request. */
    fetch: CustomFetch
    /** The access token the SDK client was built with. */
    token: string
    /** Rotate the access token, even if it hasn't expired, and return the new one. */
    refresh: () => Promise<string>
    /** Called with the error when `refresh` fails, before the 401 is returned. */
    onRefreshFailed: (error: unknown) => void
}

/**
 * Wrap the SDK client's fetch so a request the API refuses with a 401 is
 * retried once with a rotated access token. Tokens are refreshed before a
 * command starts when they are close to expiring, so this covers the rest: a
 * long command outliving its token, or a token revoked early.
 *
 * Requests refused at the same time share one refresh. Later requests carry
 * the new token, since the SDK client keeps sending the one it was built
 * with. When the refresh fails, the original 401 is returned and
 * `onRefreshFailed` gets the reason, so the error the user sees can say why.
 */
export function createRefreshingFetch(options: RefreshingFetchOptions): CustomFetch {
    let currentToken = options.token
    let pendingRefresh: Promise<string> | undefined

    function refreshOnce(): Promise<string> {
        pendingRefresh ??= options.refresh().finally(() => {
            pendingRefresh = undefined
        })
        return pendingRefresh
    }

    function withToken(init: FetchInit, token: string): FetchInit {
        if (token === options.token) return init
        const headers = new Headers(init?.headers)
        headers.set('Authorization', `Bearer ${token}`)
        return { ...init, headers }
    }

    return async (url, init) => {
        const sentToken = currentToken
        const response = await options.fetch(url, withToken(init, sentToken))
        if (response.status !== 401) return response

        // Another request may already have rotated the token since this one
        // was sent; retry with that instead of rotating it again.
        if (currentToken === sentToken) {
            try {
                currentToken = await refreshOnce()
            } catch (error) {
                options.onRefreshFailed(error)
                return response
            }
        }
        return options.fetch(url, withToken(init, currentToken))
    }
}
