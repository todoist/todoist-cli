import { refreshAccessToken, type TokenRefreshOptions } from '@todoist/cli-core/auth'
import { createTodoistAuthProvider } from './auth-provider.js'
import { createTodoistTokenStore, type TodoistAccount } from './auth-store.js'
import { REFRESH_SKEW_MS } from './auth.js'
import { getConfigPath } from './config.js'

/**
 * Refresh wiring shared by the token read path and cli-core's `auth status` /
 * `auth token view` attachers, so all of them rotate an expiring access token
 * the same way. The lock file sits next to the config, so concurrent `td`
 * processes send one refresh grant between them and the rest pick up the
 * rotated tokens.
 *
 * Kept out of `auth.ts`, which loads it only when a refresh is due: the
 * provider pulls in the SDK, and accounts whose tokens never expire (every
 * account signed in through the registered Todoist CLI app) never need it.
 */
export function getTokenRefreshOptions(): TokenRefreshOptions<TodoistAccount> {
    return {
        provider: createTodoistAuthProvider(),
        lockPath: `${getConfigPath()}.refresh.lock`,
        skewMs: REFRESH_SKEW_MS,
    }
}

/**
 * Rotate the stored access token for `userId` if it is within
 * `REFRESH_SKEW_MS` of expiring, and return the token to use.
 */
export async function refreshStoredToken(userId: string): Promise<string> {
    const { bundle } = await refreshAccessToken({
        store: createTodoistTokenStore(),
        ref: userId,
        ...getTokenRefreshOptions(),
    })
    return bundle.accessToken
}

/**
 * Replace an access token the API refused with a 401, whether or not it has
 * expired, and return the token to retry with. When the stored token is
 * already a different one, another `td` process has rotated it since this one
 * read it, so that is returned rather than rotating it again.
 */
export async function replaceRejectedToken(userId: string, rejectedToken: string): Promise<string> {
    const store = createTodoistTokenStore()
    const stored = await store.activeBundle(userId)
    if (stored && stored.bundle.accessToken !== rejectedToken) {
        return stored.bundle.accessToken
    }
    const { bundle } = await refreshAccessToken({
        store,
        ref: userId,
        ...getTokenRefreshOptions(),
        force: true,
    })
    return bundle.accessToken
}
