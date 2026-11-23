import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api/core.js', () => ({
    createApiForToken: vi.fn(),
}))

import { createMockApi } from '../test-support/mock-api.js'
import { createApiForToken } from './api/core.js'
import { createTodoistAuthProvider } from './auth-provider.js'

const mockCreateApiForToken = vi.mocked(createApiForToken)

const TEST_USER = { id: '12345', email: 'user@example.com', fullName: 'Test User' }

function stubGetUser() {
    const api = createMockApi({ getUser: vi.fn().mockResolvedValue(TEST_USER) })
    mockCreateApiForToken.mockReturnValue(api)
    return api
}

describe('createTodoistAuthProvider.validateToken', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('probes the token and builds a read-write account', async () => {
        const api = stubGetUser()
        const account = await createTodoistAuthProvider().validateToken({
            token: 'token_abc1234567',
            handshake: { readOnly: false, flags: {} },
        })

        expect(mockCreateApiForToken).toHaveBeenCalledWith('token_abc1234567')
        expect(api.getUser).toHaveBeenCalled()
        expect(account).toEqual({
            id: TEST_USER.id,
            email: TEST_USER.email,
            label: TEST_USER.email,
            auth_mode: 'read-write',
            auth_scope: 'data:read_write,data:delete,project:delete',
            auth_flags: undefined,
        })
    })

    it('combines --read-only with --additional-scopes into auth_mode/scope/flags', async () => {
        stubGetUser()
        const account = await createTodoistAuthProvider().validateToken({
            token: 'token_abc1234567',
            handshake: { readOnly: true, flags: { additionalScopes: 'backups,app-management' } },
        })

        // AUTH_FLAG_ORDER normalises ordering regardless of CLI input.
        expect(account.auth_mode).toBe('read-only')
        expect(account.auth_flags).toEqual(['read-only', 'app-management', 'backups'])
        expect(account.auth_scope).toBe('data:read,dev:app_console,backups:read')
    })

    it('records what Todoist granted, which can be less than was requested', async () => {
        stubGetUser()
        // Asked for read-write with app-management and billing; the user chose
        // read-only on the consent screen, which also narrows billing.
        const account = await createTodoistAuthProvider().validateToken({
            token: 'token_abc1234567',
            handshake: {
                readOnly: false,
                flags: { additionalScopes: 'app-management,billing' },
                clientId: 'https://api.todoist.com/.well-known/oauth-client-cli',
            },
            scope: 'data:read dev:app_console billing:read',
        })

        expect(account).toEqual({
            id: TEST_USER.id,
            email: TEST_USER.email,
            label: TEST_USER.email,
            auth_mode: 'read-only',
            auth_scope: 'data:read,dev:app_console,billing:read',
            auth_flags: ['read-only', 'app-management', 'billing'],
            oauth_client_id: 'https://api.todoist.com/.well-known/oauth-client-cli',
        })
    })

    it('records a read-write grant without the scopes Todoist dropped', async () => {
        stubGetUser()
        const account = await createTodoistAuthProvider().validateToken({
            token: 'token_abc1234567',
            handshake: { readOnly: false, flags: { additionalScopes: 'backups' } },
            scope: 'data:read_write,data:delete,project:delete',
        })

        expect(account.auth_mode).toBe('read-write')
        expect(account.auth_flags).toBeUndefined()
        expect(account.auth_scope).toBe('data:read_write,data:delete,project:delete')
    })
})

describe('createTodoistAuthProvider.authorize', () => {
    it('signs in as the client ID metadata document the Todoist API serves', async () => {
        const authorized = await createTodoistAuthProvider().authorize({
            redirectUri: 'http://localhost:8765/callback',
            state: 'state_123',
            scopes: ['data:read_write', 'data:delete', 'project:delete'],
            readOnly: false,
            flags: {},
            handshake: {},
        })
        const url = new URL(authorized.authorizeUrl)

        // Todoist binds every token to this URL, so changing it is a new client.
        expect(url.searchParams.get('client_id')).toBe(
            'https://api.todoist.com/.well-known/oauth-client-cli',
        )
        expect(url.searchParams.get('code_challenge_method')).toBe('S256')
        // exchangeCode and validateToken read the client back off the handshake.
        expect(authorized.handshake).toMatchObject({
            clientId: 'https://api.todoist.com/.well-known/oauth-client-cli',
        })
    })
})
