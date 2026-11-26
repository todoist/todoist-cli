import { SecureStoreUnavailableError } from '@todoist/cli-core/auth'
export type { TokenStorageLocation, TokenStorageResult } from '@todoist/cli-core/auth'
export {
    AUTH_FLAG_ORDER,
    CONFIG_VERSION,
    getConfigPath,
    readConfig,
    writeConfig,
    type AuthFlag,
    type AuthMode,
    type Config,
    type StoredUser,
    type UpdateChannel,
} from './config.js'

import { createTodoistTokenStore, getRequestedOrEnvUserRef, TOKEN_ENV_VAR } from './auth-store.js'
import { type AuthFlag, type AuthMode, readConfig, type StoredUser } from './config.js'
import { BaseCliError, CliError } from './errors.js'
import {
    findUserByRef,
    getEffectiveDefaultUser,
    getStoredUsers,
    NoUserSelectedError,
    UserNotFoundError,
} from './users.js'

export { TOKEN_ENV_VAR, USER_ENV_VAR } from './auth-store.js'

export interface AuthMetadata {
    authMode: AuthMode
    authScope?: string
    authFlags?: AuthFlag[]
    source: 'env' | 'secure-store' | 'config-file'
    userId?: string
    email?: string
}

export interface ResolvedUser {
    id: string
    email: string
    token: string
    authMode: AuthMode
    authScope?: string
    authFlags?: AuthFlag[]
    source: AuthMetadata['source']
    /**
     * The stored credential has a refresh token, so a request the API refuses
     * with a 401 can be retried with a rotated access token.
     */
    canRefresh: boolean
}

/**
 * Refresh an expiring access token when it has less than this left, so a
 * command doesn't start a request with a token that expires before it lands.
 */
export const REFRESH_SKEW_MS = 60_000

export class NoTokenError extends CliError {
    constructor() {
        super(
            'NO_TOKEN',
            `No API token found. Set ${TOKEN_ENV_VAR} or run \`td auth login\` or \`td auth token <token>\`.`,
            ['Set TODOIST_API_TOKEN or run: td auth login'],
            'info',
        )
        this.name = 'NoTokenError'
    }
}

/**
 * Resolve which stored user this invocation should act as, and load their
 * token. Honors `--user <ref>`, then `TD_USER`, then `user.defaultUser`, then
 * a single stored user. Throws `NoUserSelectedError` when multiple users are
 * stored without a default and none of the three named one; `UserNotFoundError`
 * when the named one does not match; `NoTokenError` when no users are stored.
 *
 * `TODOIST_API_TOKEN` short-circuits the resolver entirely — env tokens act as
 * an anonymous identity for the duration of the command.
 */
export async function resolveActiveUser(opts: { ref?: string } = {}): Promise<ResolvedUser> {
    const envToken = process.env[TOKEN_ENV_VAR]
    if (envToken) {
        return {
            id: 'env',
            email: '',
            token: envToken,
            authMode: 'unknown',
            source: 'env',
            canRefresh: false,
        }
    }

    const config = await readConfig()
    const users = getStoredUsers(config)
    const ref = opts.ref ?? getRequestedOrEnvUserRef()

    if (users.length === 0) {
        throw ref ? new UserNotFoundError(ref) : new NoTokenError()
    }

    const target = ref
        ? (findUserByRef(config, ref)?.user ?? null)
        : (getEffectiveDefaultUser(config) ?? null)
    if (!target) {
        // ref miss when records exist, or multi-user no-default.
        throw ref ? new UserNotFoundError(ref) : new NoUserSelectedError()
    }

    const { token, source } = await loadTokenForStoredUser(target)
    return {
        id: target.id,
        email: target.email,
        token,
        authMode: target.auth_mode ?? 'unknown',
        authScope: target.auth_scope,
        authFlags: target.auth_flags,
        source,
        canRefresh: hasRefreshToken(target),
    }
}

/** Bearer-only shortcut. Most call sites (SDK, uploads, stats) only need this. */
export async function getApiToken(): Promise<string> {
    return (await resolveActiveUser()).token
}

/**
 * Like `resolveActiveUser` but bundles the rendering metadata `td doctor` /
 * `td config view` want. Lets keyring read errors (`isKeyringReadError`) propagate so the
 * diagnostic surfaces can distinguish "missing token" from "broken keyring".
 */
export async function probeApiToken(): Promise<{ token: string; metadata: AuthMetadata }> {
    const resolved = await resolveActiveUser()
    return { token: resolved.token, metadata: resolvedToMetadata(resolved) }
}

export async function getAuthMetadata(): Promise<AuthMetadata> {
    try {
        return resolvedToMetadata(await resolveActiveUser())
    } catch (error) {
        // Permission/scope callers need a sensible default rather than a hard
        // failure when credentials are missing or the keyring is offline.
        if (error instanceof NoTokenError || isKeyringReadError(error)) {
            return { authMode: 'unknown', source: 'secure-store' }
        }
        throw error
    }
}

export async function listStoredUsers(): Promise<StoredUser[]> {
    return getStoredUsers(await readConfig())
}

/** The token stored in plaintext in the config, when there is one. */
function plaintextToken(user: StoredUser): string | undefined {
    return user.api_token?.trim() || undefined
}

/** Where a stored user's token lives: plaintext in the config, or the keyring. */
function sourceFor(user: StoredUser): 'config-file' | 'secure-store' {
    return plaintextToken(user) ? 'config-file' : 'secure-store'
}

function hasRefreshToken(user: StoredUser): boolean {
    return user.has_refresh_token === true || Boolean(user.refresh_token?.trim())
}

/**
 * Load the stored token, refreshing it first when it expires within
 * `REFRESH_SKEW_MS`. A record without `access_token_expires_at` holds a token
 * that never expires, so it is read exactly as it always was: no refresh, no
 * lock, no network.
 */
async function loadTokenForStoredUser(
    user: StoredUser,
): Promise<{ token: string; source: 'secure-store' | 'config-file' }> {
    const expiresAt = user.access_token_expires_at
    if (expiresAt !== undefined && expiresAt - Date.now() < REFRESH_SKEW_MS) {
        if (hasRefreshToken(user)) {
            const refreshed = await refreshExpiringToken(user.id, expiresAt)
            if (refreshed) {
                // A refresh keeps the credential where it was stored.
                return { token: refreshed, source: sourceFor(user) }
            }
        } else if (expiresAt <= Date.now()) {
            throw new CliError(
                'NO_TOKEN',
                `The stored token for ${user.email} has expired and cannot be refreshed.`,
                ['Run: td auth login'],
            )
        }
    }
    return loadStoredToken(user)
}

/**
 * Rotate an expiring token. Returns `undefined` when the refresh couldn't
 * reach Todoist but the stored token hasn't expired yet: it still works, and
 * the next command tries again. Every other failure propagates, since a
 * rejected refresh token means signing in again.
 */
async function refreshExpiringToken(
    userId: string,
    expiresAt: number,
): Promise<string | undefined> {
    const { refreshStoredToken } = await import('./auth-refresh.js')
    try {
        return await refreshStoredToken(userId)
    } catch (error) {
        const transient = (error as { code?: unknown }).code === 'AUTH_REFRESH_TRANSIENT'
        if (transient && expiresAt > Date.now()) return undefined
        throw error
    }
}

async function loadStoredToken(
    user: StoredUser,
): Promise<{ token: string; source: 'secure-store' | 'config-file' }> {
    const plaintext = plaintextToken(user)
    if (plaintext) {
        return { token: plaintext, source: 'config-file' }
    }
    // Read through cli-core's token store, never the keyring slot directly:
    // the slot's format belongs to cli-core (it holds both tokens in one
    // item). Keyring failures propagate as `AUTH_STORE_READ_FAILED` — a stored
    // v2 user with a broken keyring is not the same situation as no
    // credentials at all. See `isKeyringReadError`.
    const active = await createTodoistTokenStore().active(user.id)
    if (active) return { token: active.token, source: 'secure-store' }
    throw new NoTokenError()
}

/**
 * The stored user exists but the keyring could not return its token: the
 * credential manager is offline, or the entry is missing or unreadable.
 * Diagnostic surfaces report this apart from "no credentials at all".
 */
export function isKeyringReadError(error: unknown): boolean {
    return (
        error instanceof SecureStoreUnavailableError ||
        (error instanceof BaseCliError && error.code === 'AUTH_STORE_READ_FAILED')
    )
}

function resolvedToMetadata(resolved: ResolvedUser): AuthMetadata {
    return {
        authMode: resolved.authMode,
        authScope: resolved.authScope,
        authFlags: resolved.authFlags,
        source: resolved.source,
        userId: resolved.id === 'env' ? undefined : resolved.id,
        email: resolved.email || undefined,
    }
}
