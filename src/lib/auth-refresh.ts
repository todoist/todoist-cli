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
 * Rotate the stored access token for `userId` and return the new one.
 * Without `force`, a token that isn't within `REFRESH_SKEW_MS` of expiring
 * comes back unchanged. `force` rotates regardless, for a request the API has
 * already refused with a 401.
 */
export async function refreshStoredToken(
    userId: string,
    options: { force?: boolean } = {},
): Promise<string> {
    const { bundle } = await refreshAccessToken({
        store: createTodoistTokenStore(),
        ref: userId,
        ...getTokenRefreshOptions(),
        force: options.force,
    })
    return bundle.accessToken
}
