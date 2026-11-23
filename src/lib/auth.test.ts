import { captureConsole } from '@todoist/cli-core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const TEST_HOME = '/tmp/todoist-cli-tests'
const TEST_CONFIG_PATH = `${TEST_HOME}/.config/todoist-cli/config.json`

interface KeyringEntryState {
    token: string | null
    getCalls: number
    setCalls: string[]
    deleteCalls: number
}

interface KeyringMockState {
    entries: Map<string, KeyringEntryState>
    getError?: Error
    setError?: Error
    deleteError?: Error
    constructed: { service: string; account: string }[]
}

function isRefreshLock(path: string): boolean {
    return path === `${TEST_CONFIG_PATH}.refresh.lock`
}

function entryFor(state: KeyringMockState, account: string): KeyringEntryState {
    let e = state.entries.get(account)
    if (!e) {
        e = { token: null, getCalls: 0, setCalls: [], deleteCalls: 0 }
        state.entries.set(account, e)
    }
    return e
}

describe('lib/auth', () => {
    let configContent: string | null
    let mkdirMock: ReturnType<typeof vi.fn>
    let readFileMock: ReturnType<typeof vi.fn>
    let unlinkMock: ReturnType<typeof vi.fn>
    let writeFileMock: ReturnType<typeof vi.fn>
    let lockContent: string | null
    let keyring: KeyringMockState
    let errorSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.unstubAllEnvs()

        configContent = null
        lockContent = null
        keyring = {
            entries: new Map(),
            constructed: [],
        }

        mkdirMock = vi.fn().mockResolvedValue(undefined)
        // The token refresh lock sits next to the config file, so reads and
        // deletes route by path: releasing the lock must not delete the config.
        readFileMock = vi.fn().mockImplementation(async (path: string) => {
            if (isRefreshLock(path)) {
                if (lockContent === null) throw createErrnoError('ENOENT')
                return lockContent
            }
            if (configContent === null) {
                throw createErrnoError('ENOENT')
            }
            return configContent
        })
        unlinkMock = vi.fn().mockImplementation(async (path: string) => {
            if (isRefreshLock(path)) {
                if (lockContent === null) throw createErrnoError('ENOENT')
                lockContent = null
                return
            }
            if (configContent === null) {
                throw createErrnoError('ENOENT')
            }
            configContent = null
        })
        writeFileMock = vi.fn().mockImplementation(async (_path: string, content: string) => {
            configContent = content
        })

        vi.doMock('node:os', () => ({
            homedir: () => TEST_HOME,
        }))

        vi.doMock('node:fs/promises', () => ({
            chmod: vi.fn().mockResolvedValue(undefined),
            mkdir: mkdirMock,
            readFile: readFileMock,
            unlink: unlinkMock,
            writeFile: writeFileMock,
            open: vi.fn().mockImplementation(async (path: string) => {
                if (!isRefreshLock(path)) throw new Error(`unexpected open: ${path}`)
                if (lockContent !== null) throw createErrnoError('EEXIST')
                lockContent = ''
                return {
                    writeFile: async (content: string) => {
                        lockContent = content
                    },
                    close: async () => {},
                }
            }),
            stat: vi.fn().mockImplementation(async () => ({ mtimeMs: Date.now() })),
        }))

        // Override @todoist/cli-core's getConfigPath at the package boundary so
        // we don't depend on `node:os` mock substitution reaching cli-core's
        // compiled `homedir()` call — that route works on macOS but not on
        // Linux runners under vitest 4's `server.deps.inline`. The node:os
        // mock above is left in place for any other code that reads homedir
        // directly.
        vi.doMock('@todoist/cli-core', async () => {
            const actual =
                await vi.importActual<typeof import('@todoist/cli-core')>('@todoist/cli-core')
            return {
                ...actual,
                getConfigPath: () => TEST_CONFIG_PATH,
            }
        })

        // Mock cli-core's `createSecureStore` directly. Inlining cli-core via
        // `server.deps.inline` is not sufficient on Linux + npm-linked cli-core:
        // the dynamic `import('@napi-rs/keyring')` inside cli-core resolves
        // against the symlink target and bypasses vitest's mock. Mocking
        // `@todoist/cli-core/auth` is the reliable boundary — it preserves the
        // typed `SecureStoreUnavailableError` re-export so the actual class
        // identity carries across the test/import boundary.
        vi.doMock('@todoist/cli-core/auth', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@todoist/cli-core/auth')>()
            const { SecureStoreUnavailableError } = actual
            return {
                ...actual,
                createSecureStore: ({
                    serviceName,
                    account,
                }: {
                    serviceName: string
                    account: string
                }) => {
                    keyring.constructed.push({ service: serviceName, account })
                    return {
                        async getSecret() {
                            if (keyring.getError) {
                                throw new SecureStoreUnavailableError(keyring.getError.message)
                            }
                            const e = entryFor(keyring, account)
                            e.getCalls += 1
                            return e.token
                        },
                        async setSecret(password: string) {
                            if (keyring.setError) {
                                throw new SecureStoreUnavailableError(keyring.setError.message)
                            }
                            const e = entryFor(keyring, account)
                            e.token = password
                            e.setCalls.push(password)
                        },
                        async deleteSecret() {
                            if (keyring.deleteError) {
                                throw new SecureStoreUnavailableError(keyring.deleteError.message)
                            }
                            const e = entryFor(keyring, account)
                            const had = e.token !== null
                            e.token = null
                            e.deleteCalls += 1
                            return had
                        },
                    }
                },
            }
        })

        errorSpy = captureConsole('error')
    })

    afterEach(() => {
        errorSpy.mockRestore()
        vi.unstubAllEnvs()
    })

    // --- env var --------------------------------------------------------------

    it('TODOIST_API_TOKEN bypasses stored users', async () => {
        vi.stubEnv('TODOIST_API_TOKEN', 'env-token-123456')
        setConfig({
            config_version: 2,
            users: [{ id: '1', email: 'a@b.c', api_token: 'config-token' }],
        })

        const { getApiToken, resolveActiveUser } = await import('./auth.js')

        await expect(getApiToken()).resolves.toBe('env-token-123456')
        await expect(resolveActiveUser()).resolves.toMatchObject({
            id: 'env',
            source: 'env',
        })
        expect(keyring.constructed).toEqual([])
    })

    // --- resolveActiveUser ----------------------------------------------------

    it('resolves single stored user implicitly', async () => {
        setConfig({
            config_version: 2,
            users: [{ id: '111', email: 'a@b.c' }],
        })
        entryFor(keyring, 'user-111').token = 'stored-token'

        const { resolveActiveUser } = await import('./auth.js')

        await expect(resolveActiveUser()).resolves.toMatchObject({
            id: '111',
            email: 'a@b.c',
            token: 'stored-token',
            source: 'secure-store',
        })
    })

    it('resolves the configured default user when multiple are stored', async () => {
        setConfig({
            config_version: 2,
            user: { defaultUser: '222' },
            users: [
                { id: '111', email: 'a@b.c' },
                { id: '222', email: 'd@e.f' },
            ],
        })
        entryFor(keyring, 'user-222').token = 'token-222'

        const { resolveActiveUser } = await import('./auth.js')

        await expect(resolveActiveUser()).resolves.toMatchObject({ id: '222', token: 'token-222' })
    })

    it('errors when multiple users are stored without a default and no --user', async () => {
        setConfig({
            config_version: 2,
            users: [
                { id: '111', email: 'a@b.c' },
                { id: '222', email: 'd@e.f' },
            ],
        })

        const { resolveActiveUser } = await import('./auth.js')
        const { NoUserSelectedError } = await import('./users.js')

        await expect(resolveActiveUser()).rejects.toBeInstanceOf(NoUserSelectedError)
    })

    it('honors an explicit ref override', async () => {
        setConfig({
            config_version: 2,
            user: { defaultUser: '111' },
            users: [
                { id: '111', email: 'a@b.c' },
                { id: '222', email: 'D@E.F' },
            ],
        })
        entryFor(keyring, 'user-222').token = 'token-222'

        const { resolveActiveUser } = await import('./auth.js')

        // case-insensitive email match
        await expect(resolveActiveUser({ ref: 'd@e.f' })).resolves.toMatchObject({
            id: '222',
            token: 'token-222',
        })
        // exact id match
        await expect(resolveActiveUser({ ref: '222' })).resolves.toMatchObject({ id: '222' })
    })

    it('TD_USER names the account when no --user was given', async () => {
        vi.stubEnv('TD_USER', 'd@e.f')
        setConfig({
            config_version: 2,
            users: [
                { id: '111', email: 'a@b.c' },
                { id: '222', email: 'd@e.f' },
            ],
        })
        entryFor(keyring, 'user-222').token = 'token-222'

        const { resolveActiveUser } = await import('./auth.js')

        await expect(resolveActiveUser()).resolves.toMatchObject({ id: '222' })
    })

    it('the --user flag beats TD_USER', async () => {
        // Through argv rather than through `opts.ref`: production callers pass
        // no ref, so the flag reaches the resolver via the global-args store,
        // and that is the precedence worth pinning.
        const realArgv = process.argv
        process.argv = ['node', 'td', '--user', '111', 'task', 'list']
        vi.stubEnv('TD_USER', '222')
        setConfig({
            config_version: 2,
            users: [
                { id: '111', email: 'a@b.c' },
                { id: '222', email: 'd@e.f' },
            ],
        })
        entryFor(keyring, 'user-111').token = 'token-111'

        const { resetGlobalArgs } = await import('./global-args.js')
        resetGlobalArgs()
        const { resolveActiveUser } = await import('./auth.js')

        try {
            await expect(resolveActiveUser()).resolves.toMatchObject({ id: '111' })
        } finally {
            process.argv = realArgv
            resetGlobalArgs()
        }
    })

    it('an explicit ref beats TD_USER', async () => {
        vi.stubEnv('TD_USER', '222')
        setConfig({
            config_version: 2,
            users: [
                { id: '111', email: 'a@b.c' },
                { id: '222', email: 'd@e.f' },
            ],
        })
        entryFor(keyring, 'user-111').token = 'token-111'

        const { resolveActiveUser } = await import('./auth.js')

        await expect(resolveActiveUser({ ref: '111' })).resolves.toMatchObject({ id: '111' })
    })

    it('TODOIST_API_TOKEN still short-circuits ahead of TD_USER', async () => {
        vi.stubEnv('TODOIST_API_TOKEN', 'env-token-123456')
        vi.stubEnv('TD_USER', '222')
        setConfig({
            config_version: 2,
            users: [{ id: '222', email: 'd@e.f' }],
        })

        const { resolveActiveUser } = await import('./auth.js')

        await expect(resolveActiveUser()).resolves.toMatchObject({ id: 'env', source: 'env' })
    })

    it('treats an empty TD_USER as unset rather than as an account name', async () => {
        vi.stubEnv('TD_USER', '')
        setConfig({
            config_version: 2,
            users: [{ id: '111', email: 'a@b.c' }],
        })
        entryFor(keyring, 'user-111').token = 'stored-token'

        const { resolveActiveUser } = await import('./auth.js')

        await expect(resolveActiveUser()).resolves.toMatchObject({ id: '111' })
    })

    it('reports an unresolvable TD_USER the same way an unresolvable --user is reported', async () => {
        vi.stubEnv('TD_USER', 'nope')
        setConfig({
            config_version: 2,
            users: [{ id: '111', email: 'a@b.c' }],
        })

        const { resolveActiveUser } = await import('./auth.js')
        const { UserNotFoundError } = await import('./users.js')

        await expect(resolveActiveUser()).rejects.toBeInstanceOf(UserNotFoundError)
    })

    it('throws UserNotFoundError when ref does not match', async () => {
        setConfig({
            config_version: 2,
            users: [{ id: '111', email: 'a@b.c' }],
        })

        const { resolveActiveUser } = await import('./auth.js')
        const { UserNotFoundError } = await import('./users.js')

        await expect(resolveActiveUser({ ref: 'nope' })).rejects.toBeInstanceOf(UserNotFoundError)
    })

    // --- probe / metadata under keyring failure -------------------------------

    it('probeApiToken surfaces SecureStoreUnavailableError instead of NoTokenError', async () => {
        // Stored v2 user, no plaintext fallback; keyring is offline. The
        // diagnostic surface needs to tell "credentials missing" apart from
        // "credential manager broken".
        setConfig({
            config_version: 2,
            users: [{ id: '111', email: 'a@b.c' }],
        })
        keyring.getError = new Error('keychain locked')

        const { probeApiToken } = await import('./auth.js')
        const { SecureStoreUnavailableError } = await import('@todoist/cli-core/auth')

        await expect(probeApiToken()).rejects.toBeInstanceOf(SecureStoreUnavailableError)
    })

    it('getAuthMetadata degrades to unknown when the keyring is offline', async () => {
        // Permission/scope checks must not hard-fail when the credential
        // store is unavailable — they fall through to the same "unknown"
        // default they use when no token exists.
        setConfig({
            config_version: 2,
            users: [{ id: '111', email: 'a@b.c' }],
        })
        keyring.getError = new Error('keychain locked')

        const { getAuthMetadata } = await import('./auth.js')

        await expect(getAuthMetadata()).resolves.toEqual({
            authMode: 'unknown',
            source: 'secure-store',
        })
    })

    // --- expiring OAuth tokens ------------------------------------------------

    describe('expiring OAuth tokens', () => {
        const TOKEN_URL = 'https://todoist.com/oauth/access_token'
        let fetchTodoistMock: ReturnType<typeof vi.fn>

        beforeEach(() => {
            fetchTodoistMock = vi.fn()
            vi.doMock('./usage-tracking.js', async (importOriginal) => ({
                ...(await importOriginal<typeof import('./usage-tracking.js')>()),
                fetchTodoist: fetchTodoistMock,
            }))
        })

        afterEach(() => {
            // `vi.doMock` registrations outlive `vi.resetModules()`.
            vi.doUnmock('./auth-refresh.js')
        })

        function plaintextUser(overrides: Record<string, unknown> = {}) {
            return {
                id: '111',
                email: 'a@b.c',
                auth_mode: 'read-write',
                api_token: 'old-access',
                ...overrides,
            }
        }

        function tokenResponse(body: Record<string, unknown>): Response {
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        }

        function persistedUser(): Record<string, unknown> {
            return (JSON.parse(configContent as string) as { users: Record<string, unknown>[] })
                .users[0]
        }

        it('refreshes a token that expires within a minute and saves the rotated tokens', async () => {
            setConfig({
                config_version: 2,
                users: [
                    plaintextUser({
                        refresh_token: 'old-refresh',
                        access_token_expires_at: Date.now() + 30_000,
                        has_refresh_token: true,
                    }),
                ],
            })
            fetchTodoistMock.mockResolvedValue(
                tokenResponse({
                    access_token: 'new-access',
                    refresh_token: 'new-refresh',
                    token_type: 'Bearer',
                    expires_in: 3600,
                }),
            )

            const { getApiToken } = await import('./auth.js')
            const before = Date.now()

            await expect(getApiToken()).resolves.toBe('new-access')

            expect(fetchTodoistMock).toHaveBeenCalledTimes(1)
            const [url, init] = fetchTodoistMock.mock.calls[0] as [string, RequestInit]
            expect(String(url)).toBe(TOKEN_URL)
            expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toMatchObject({
                grant_type: 'refresh_token',
                refresh_token: 'old-refresh',
                client_id: '04863cc1e3584830a578622f50224d5b',
            })
            expect(persistedUser()).toMatchObject({
                api_token: 'new-access',
                refresh_token: 'new-refresh',
                has_refresh_token: true,
            })
            const expiresAt = persistedUser().access_token_expires_at as number
            expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000)
            expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000)
            // The lock is released, so the next refresh can take it.
            expect(lockContent).toBeNull()
        })

        it('never refreshes a token with no stored expiry', async () => {
            setConfig({ config_version: 2, users: [plaintextUser()] })

            const { getApiToken } = await import('./auth.js')

            await expect(getApiToken()).resolves.toBe('old-access')
            expect(fetchTodoistMock).not.toHaveBeenCalled()
        })

        it('keeps using an expiring token it cannot refresh until it has expired', async () => {
            setConfig({
                config_version: 2,
                users: [plaintextUser({ access_token_expires_at: Date.now() + 30_000 })],
            })

            const { getApiToken } = await import('./auth.js')

            await expect(getApiToken()).resolves.toBe('old-access')
            expect(fetchTodoistMock).not.toHaveBeenCalled()
        })

        it('asks for a new login once a token it cannot refresh has expired', async () => {
            setConfig({
                config_version: 2,
                users: [plaintextUser({ access_token_expires_at: Date.now() - 1_000 })],
            })

            const { getApiToken } = await import('./auth.js')

            await expect(getApiToken()).rejects.toMatchObject({
                code: 'NO_TOKEN',
                hints: ['Run: td auth login'],
            })
            expect(fetchTodoistMock).not.toHaveBeenCalled()
        })

        it('reuses a token another process already rotated instead of rotating it again', async () => {
            setConfig({
                config_version: 2,
                users: [
                    plaintextUser({
                        api_token: 'rotated-elsewhere',
                        refresh_token: 'current-refresh',
                        access_token_expires_at: Date.now() + 1_800_000,
                        has_refresh_token: true,
                    }),
                ],
            })

            const { replaceRejectedToken } = await import('./auth-refresh.js')

            await expect(replaceRejectedToken('111', 'old-access')).resolves.toBe(
                'rotated-elsewhere',
            )
            expect(fetchTodoistMock).not.toHaveBeenCalled()
        })

        it('rotates a refused token even when it has not expired yet', async () => {
            setConfig({
                config_version: 2,
                users: [
                    plaintextUser({
                        refresh_token: 'old-refresh',
                        access_token_expires_at: Date.now() + 1_800_000,
                        has_refresh_token: true,
                    }),
                ],
            })
            fetchTodoistMock.mockResolvedValue(
                tokenResponse({
                    access_token: 'new-access',
                    refresh_token: 'new-refresh',
                    token_type: 'Bearer',
                    expires_in: 3600,
                }),
            )

            const { replaceRejectedToken } = await import('./auth-refresh.js')

            await expect(replaceRejectedToken('111', 'old-access')).resolves.toBe('new-access')
            expect(persistedUser()).toMatchObject({
                api_token: 'new-access',
                refresh_token: 'new-refresh',
            })
        })

        it('refreshes a keyring-backed account, whose refresh token is only in the keyring', async () => {
            // The record carries just the flag; the refresh token sits in the
            // `user-111/refresh` keyring slot, which cli-core reads itself.
            setConfig({
                config_version: 2,
                users: [
                    {
                        id: '111',
                        email: 'a@b.c',
                        access_token_expires_at: Date.now() + 30_000,
                        has_refresh_token: true,
                    },
                ],
            })
            entryFor(keyring, 'user-111').token = 'old-access'
            const refreshStoredToken = vi.fn().mockResolvedValue('new-access')
            vi.doMock('./auth-refresh.js', () => ({ refreshStoredToken }))

            const { resolveActiveUser } = await import('./auth.js')

            await expect(resolveActiveUser()).resolves.toMatchObject({
                token: 'new-access',
                source: 'secure-store',
                canRefresh: true,
            })
            expect(refreshStoredToken).toHaveBeenCalledWith('111')
        })

        it('asks for a new login when Todoist rejects the refresh token', async () => {
            setConfig({
                config_version: 2,
                users: [
                    plaintextUser({
                        refresh_token: 'revoked-refresh',
                        access_token_expires_at: Date.now() + 30_000,
                        has_refresh_token: true,
                    }),
                ],
            })
            fetchTodoistMock.mockResolvedValue(
                new Response(JSON.stringify({ error: 'invalid_grant' }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )

            const { getApiToken } = await import('./auth.js')

            // Even though the stored token has 30 seconds left, a refresh
            // token Todoist rejects won't recover; say so now.
            await expect(getApiToken()).rejects.toMatchObject({ code: 'AUTH_REFRESH_EXPIRED' })
        })

        it('keeps the stored token when a refresh fails to connect before it expires', async () => {
            setConfig({
                config_version: 2,
                users: [
                    plaintextUser({
                        refresh_token: 'old-refresh',
                        access_token_expires_at: Date.now() + 30_000,
                        has_refresh_token: true,
                    }),
                ],
            })
            fetchTodoistMock.mockRejectedValue(new TypeError('fetch failed'))

            const { getApiToken } = await import('./auth.js')

            await expect(getApiToken()).resolves.toBe('old-access')
            expect(persistedUser()).toMatchObject({ refresh_token: 'old-refresh' })
        })
    })

    function setConfig(config: Record<string, unknown>): void {
        configContent = `${JSON.stringify(config, null, 2)}\n`
    }

    function createErrnoError(code: string): Error & { code: string } {
        const error = new Error(code) as Error & { code: string }
        error.code = code
        return error
    }
})
