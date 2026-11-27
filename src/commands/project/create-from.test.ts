import fs from 'node:fs'
import { open } from 'node:fs/promises'
import { captureConsole, createTestProgram } from '@todoist/cli-core/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs')
vi.mock('node:fs/promises', () => ({
    open: vi.fn(),
}))
vi.mock('../../lib/api/core.js', () => ({
    getApi: vi.fn(),
}))
vi.mock('../../lib/refs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/refs.js')>()
    return {
        ...actual,
        resolveWorkspaceRef: vi.fn(),
        resolveFolderRef: vi.fn(),
    }
})

import { resolveFolderRef, resolveWorkspaceRef } from '../../lib/refs.js'
import { setupApiMock } from '../../test-support/api-mock.js'
import { fixtures } from '../../test-support/fixtures.js'
import { type MockApi } from '../../test-support/mock-api.js'
import { registerProjectCommand } from './index.js'

const created = { ...fixtures.projects.work, id: 'new-proj', name: 'Product Launch' }

function run(...args: string[]) {
    return createTestProgram(registerProjectCommand).parseAsync([
        'node',
        'td',
        'project',
        'create',
        ...args,
    ])
}

describe('project create from a source', () => {
    let mockApi: MockApi
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = setupApiMock()
        consoleSpy = captureConsole()
        vi.mocked(open).mockResolvedValue({ close: vi.fn() } as unknown as Awaited<
            ReturnType<typeof open>
        >)
        vi.mocked(fs.openAsBlob).mockResolvedValue(new Blob([Buffer.from('csv content')]))
        vi.mocked(resolveWorkspaceRef).mockResolvedValue({ id: 'ws-1', name: 'Acme' } as Awaited<
            ReturnType<typeof resolveWorkspaceRef>
        >)
        vi.mocked(resolveFolderRef).mockResolvedValue({
            id: 'folder-1',
            name: 'Marketing',
        } as Awaited<ReturnType<typeof resolveFolderRef>>)
        mockApi.addProjectFromTemplateId.mockResolvedValue({ status: 'ok', projectId: 'new-proj' })
        mockApi.addProjectFromCsv.mockResolvedValue({
            status: 'ok',
            projectId: 'new-proj',
            templateType: 'project',
            projects: [],
            sections: [],
            tasks: [fixtures.tasks.basic],
            comments: [],
        })
        mockApi.getProject.mockResolvedValue(created)
    })

    describe('--from-template', () => {
        it('creates a personal project named after the template', async () => {
            await run('--from-template', 'product-launch')

            expect(mockApi.getPersonalProjectCapacity).toHaveBeenCalled()
            expect(mockApi.addProjectFromTemplateId).toHaveBeenCalledWith({
                templateId: 'product-launch',
                name: undefined,
                locale: undefined,
                workspaceId: undefined,
                folderId: undefined,
            })
            expect(mockApi.getProject).toHaveBeenCalledWith('new-proj')
            expect(consoleSpy).toHaveBeenCalledWith('Created: Product Launch')
        })

        it('creates it in a workspace folder, without checking the personal limit', async () => {
            await run(
                '--from-template',
                'product-launch',
                '--name',
                'Launch',
                '--locale',
                'fr',
                '--workspace',
                'Acme',
                '--folder',
                'Marketing',
            )

            expect(resolveFolderRef).toHaveBeenCalledWith('Marketing', 'ws-1')
            expect(mockApi.getPersonalProjectCapacity).not.toHaveBeenCalled()
            expect(mockApi.addProjectFromTemplateId).toHaveBeenCalledWith({
                templateId: 'product-launch',
                name: 'Launch',
                locale: 'fr',
                workspaceId: 'ws-1',
                folderId: 'folder-1',
            })
        })

        it('outputs the created project with --json', async () => {
            await run('--from-template', 'product-launch', '--json')

            const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)
            expect(parsed.id).toBe('new-proj')
            expect(parsed.name).toBe('Product Launch')
        })

        it('stops at the personal project limit', async () => {
            mockApi.getPersonalProjectCapacity.mockResolvedValue({
                maxProjects: 5,
                activeCount: 5,
                remaining: 0,
            })

            await expect(run('--from-template', 'product-launch')).rejects.toMatchObject({
                code: 'PROJECT_LIMIT_REACHED',
            })
            expect(mockApi.addProjectFromTemplateId).not.toHaveBeenCalled()
        })
    })

    describe('--from-csv', () => {
        it('uploads the CSV and shows what was imported', async () => {
            await run('--name', 'Q2 plan', '--from-csv', '/tmp/plan.csv', '--workspace', 'Acme')

            const arg = mockApi.addProjectFromCsv.mock.calls[0][0]
            expect(arg).toMatchObject({
                name: 'Q2 plan',
                fileName: 'plan.csv',
                workspaceId: 'ws-1',
            })
            expect(await (arg.file as Blob).text()).toBe('csv content')
            expect(consoleSpy).toHaveBeenCalledWith('Created: Product Launch')
            expect(consoleSpy).toHaveBeenCalledWith('Imported: 1 tasks')
        })

        it('needs --name', async () => {
            await expect(run('--from-csv', '/tmp/plan.csv')).rejects.toMatchObject({
                code: 'MISSING_NAME',
            })
            expect(mockApi.addProjectFromCsv).not.toHaveBeenCalled()
        })
    })

    it('previews with --dry-run without calling the API', async () => {
        await run('--from-template', 'product-launch', '--dry-run')

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'))
        expect(mockApi.addProjectFromTemplateId).not.toHaveBeenCalled()
    })

    describe('options per source', () => {
        it.each([
            [['--from-template', 'x', '--color', 'red'], 'INVALID_OPTIONS'],
            [['--from-template', 'x', '--favorite'], 'INVALID_OPTIONS'],
            [['--from-template', 'x', '--parent', 'Work'], 'INVALID_OPTIONS'],
            [['--from-template', 'x', '--description', 'Text'], 'INVALID_OPTIONS'],
            [['--from-template', 'x', '--folder', 'Marketing'], 'INVALID_OPTIONS'],
            [['--from-template', 'x', '--file-name', 'a.csv'], 'INVALID_OPTIONS'],
            [
                ['--name', 'A', '--from-csv', '/tmp/a.csv', '--folder', 'F', '--workspace', 'Acme'],
                'INVALID_OPTIONS',
            ],
            [['--name', 'A', '--from-csv', '/tmp/a.csv', '--locale', 'fr'], 'INVALID_OPTIONS'],
            [
                ['--name', 'A', '--from-csv', '/tmp/a.csv', '--from-template', 'x'],
                'CONFLICTING_OPTIONS',
            ],
            [['--name', 'A', '--workspace', 'Acme'], 'INVALID_OPTIONS'],
        ])('rejects %j with %s and creates nothing', async (args, code) => {
            await expect(run(...args)).rejects.toMatchObject({ code })
            expect(mockApi.addProjectFromTemplateId).not.toHaveBeenCalled()
            expect(mockApi.addProjectFromCsv).not.toHaveBeenCalled()
            expect(mockApi.addProject).not.toHaveBeenCalled()
        })

        it('points to td project update for the options it rejects', async () => {
            await expect(
                run('--from-template', 'x', '--color', 'red', '--favorite'),
            ).rejects.toMatchObject({
                message: "--color, --favorite can't be used with --from-csv or --from-template",
                hints: [expect.stringContaining('td project update')],
            })
        })
    })
})
