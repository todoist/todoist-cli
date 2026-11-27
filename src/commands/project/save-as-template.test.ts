import { captureConsole, createTestProgram } from '@todoist/cli-core/testing'
import type { Template } from '@todoist/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/api/core.js', () => ({
    getApi: vi.fn(),
}))
vi.mock('../../lib/refs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/refs.js')>()
    return {
        ...actual,
        resolveProjectRef: vi.fn(),
    }
})

import { resolveProjectRef } from '../../lib/refs.js'
import { setupApiMock } from '../../test-support/api-mock.js'
import { fixtures } from '../../test-support/fixtures.js'
import { type MockApi } from '../../test-support/mock-api.js'
import { registerProjectCommand } from './index.js'

const mockResolveProjectRef = vi.mocked(resolveProjectRef)

const saved = {
    id: 'UT_abc',
    name: 'Work',
    workspaceId: null,
    sharedWithWorkspaceMembers: false,
} as unknown as Template

function run(...args: string[]) {
    return createTestProgram(registerProjectCommand).parseAsync([
        'node',
        'td',
        'project',
        'save-as-template',
        ...args,
    ])
}

describe('project save-as-template', () => {
    let mockApi: MockApi
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = setupApiMock()
        consoleSpy = captureConsole()
        mockResolveProjectRef.mockResolvedValue(fixtures.projects.work)
        mockApi.saveProjectAsTemplate.mockResolvedValue(saved)
    })

    it("defaults the name and color to the project's", async () => {
        await run('Work', '--description', 'Weekly work')

        expect(mockApi.saveProjectAsTemplate).toHaveBeenCalledWith({
            projectId: fixtures.projects.work.id,
            name: fixtures.projects.work.name,
            description: 'Weekly work',
            color: fixtures.projects.work.color,
            forWorkspace: undefined,
        })
        expect(consoleSpy).toHaveBeenCalledWith('Saved template: Work')
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('ID: UT_abc'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Personal template'))
    })

    it('uses --name and --color', async () => {
        await run('Work', '--name', 'Sprint', '--description', 'x', '--color', 'lime_green')

        expect(mockApi.saveProjectAsTemplate).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Sprint', color: 'lime_green' }),
        )
    })

    it('falls back to charcoal when the project color is not a template color', async () => {
        mockResolveProjectRef.mockResolvedValue({ ...fixtures.projects.work, color: 'not_a_color' })

        await run('Work', '--description', 'x')

        expect(mockApi.saveProjectAsTemplate).toHaveBeenCalledWith(
            expect.objectContaining({ color: 'charcoal' }),
        )
    })

    it('rejects an unknown --color before calling the API', async () => {
        await expect(run('Work', '--description', 'x', '--color', 'mauve')).rejects.toThrow()
        expect(mockApi.saveProjectAsTemplate).not.toHaveBeenCalled()
    })

    it('needs --description', async () => {
        await expect(run('Work')).rejects.toThrow()
        expect(mockApi.saveProjectAsTemplate).not.toHaveBeenCalled()
    })

    it("saves a workspace project's template to its workspace with --for-workspace", async () => {
        mockResolveProjectRef.mockResolvedValue(fixtures.projects.workspaceProject)
        mockApi.saveProjectAsTemplate.mockResolvedValue({ ...saved, workspaceId: 'ws-1' })

        await run('Team', '--description', 'x', '--for-workspace')

        expect(mockApi.saveProjectAsTemplate).toHaveBeenCalledWith(
            expect.objectContaining({ forWorkspace: true }),
        )
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Workspace template'))
    })

    it('rejects --for-workspace on a personal project', async () => {
        await expect(run('Work', '--description', 'x', '--for-workspace')).rejects.toMatchObject({
            code: 'INVALID_OPTIONS',
        })
        expect(mockApi.saveProjectAsTemplate).not.toHaveBeenCalled()
    })

    it('outputs the saved template with --json', async () => {
        await run('Work', '--description', 'x', '--json')

        expect(JSON.parse(consoleSpy.mock.calls[0][0] as string).id).toBe('UT_abc')
    })

    it('previews with --dry-run without saving', async () => {
        await run('Work', '--description', 'x', '--dry-run')

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'))
        expect(mockApi.saveProjectAsTemplate).not.toHaveBeenCalled()
    })
})
