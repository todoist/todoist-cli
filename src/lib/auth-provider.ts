import { type AuthProvider, createPkceProvider } from '@todoist/cli-core/auth'
import { createApiForToken } from './api/core.js'
import { type TodoistAccount, toTodoistAccount } from './auth-store.js'
import { type AuthFlag } from './config.js'
import { describeGrantedScope, extractAdditionalScopes, resolveAuthScope } from './oauth-scopes.js'
import { fetchTodoist } from './usage-tracking.js'

/**
 * The CLI's OAuth `client_id`: the URL of its client ID metadata document,
 * which the Todoist backend serves. Todoist fetches the document from exactly
 * this URL at every login and binds every token it issues to that client, so
 * it must never change.
 *
 * Accounts that signed in through the registered Todoist CLI app hold tokens
 * that never expire. They never refresh, so they never need that app's id.
 */
export const OAUTH_CLIENT_ID = 'https://api.todoist.com/.well-known/oauth-client-cli'
const OAUTH_AUTHORIZE_URL = 'https://todoist.com/oauth/authorize'
const OAUTH_TOKEN_URL = 'https://todoist.com/oauth/access_token'
// Todoist's PKCE verifier alphabet: RFC 7636 unreserved minus `~`. Keep this
// exact so existing tokens that interrogate the verifier continue to validate.
const TODOIST_VERIFIER_ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/**
 * Build an `AuthProvider<TodoistAccount>` driven by cli-core's PKCE factory.
 *
 * The wrapper only overrides `validateToken`, which assembles the
 * `auth_mode` / `auth_scope` / `auth_flags` triplet todoist persists per
 * account, plus the `oauth_client_id` a refresh needs. The triplet comes from
 * the scope Todoist granted, or, when the token response doesn't say, from the
 * `flags` and `readOnly` values `runOAuthFlow` folds into the handshake.
 *
 * The token-endpoint POST is routed through `fetchTodoist` so the usage-
 * tracking headers (User-Agent, Doist-OS, …) are included.
 */
export function createTodoistAuthProvider(): AuthProvider<TodoistAccount> {
    return {
        ...createPkceProvider<TodoistAccount>({
            authorizeUrl: OAUTH_AUTHORIZE_URL,
            tokenUrl: OAUTH_TOKEN_URL,
            // A login starts from an empty handshake, so it uses OAUTH_CLIENT_ID.
            // A refresh carries the client the token was issued to
            // (`getTokenRefreshOptions`), which Todoist requires.
            clientId: ({ handshake }) =>
                typeof handshake.clientId === 'string' && handshake.clientId
                    ? handshake.clientId
                    : OAUTH_CLIENT_ID,
            scopeSeparator: ',',
            verifierAlphabet: TODOIST_VERIFIER_ALPHABET,
            verifierLength: 64,
            validate: async () => {
                // Replaced below — kept narrow so a regression surfaces here.
                throw new Error('createTodoistAuthProvider: validate() must be overridden')
            },
            fetchImpl: (input, init) => fetchTodoist(input as string | URL, init ?? {}),
        }),
        async validateToken({ token, handshake, scope }) {
            const probeApi = createApiForToken(token)
            const user = await probeApi.getUser()

            // Record what Todoist granted when it says; it can be less than
            // was asked for. Otherwise fall back to the request.
            const { authMode, authScope, authFlags } = scope
                ? describeGrantedScope(scope)
                : describeRequestedScope(handshake)

            return toTodoistAccount({
                id: user.id,
                email: user.email,
                authMode,
                authScope,
                authFlags: authFlags.length > 0 ? authFlags : undefined,
                oauthClientId:
                    typeof handshake.clientId === 'string' ? handshake.clientId : undefined,
            })
        },
    }
}

/** The scope a login asked for, from the `--read-only` / `--additional-scopes` flags. */
function describeRequestedScope(handshake: Record<string, unknown>): {
    authMode: 'read-only' | 'read-write'
    authScope: string
    authFlags: AuthFlag[]
} {
    const flags = (handshake.flags as Record<string, unknown> | undefined) ?? {}
    const readOnly = Boolean(handshake.readOnly)
    const additionalScopes = extractAdditionalScopes(flags)
    return {
        authMode: readOnly ? 'read-only' : 'read-write',
        authScope: resolveAuthScope({ readOnly, additionalScopes }),
        authFlags: [...(readOnly ? (['read-only'] as const) : []), ...additionalScopes],
    }
}
