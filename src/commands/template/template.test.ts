import fs from 'node:fs'
import { open } from 'node:fs/promises'
import { captureConsole, captureStream, createTestProgram } from '@todoist/cli-core/testing'
import type { Template } from '@todoist/sdk'
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
        resolveProjectRef: vi.fn(),
        resolveWorkspaceRef: vi.fn(),
    }
})

import { getApi } from '../../lib/api/core.js'
import { resolveProjectRef, resolveWorkspaceRef } from '../../lib/refs.js'
import { setupApiMock } from '../../test-support/api-mock.js'
import { fixtures } from '../../test-support/fixtures.js'
import { type MockApi } from '../../test-support/mock-api.js'
import { registerTemplateCommand } from './index.js'

const mockGetApi = vi.mocked(getApi)
const mockResolveProjectRef = vi.mocked(resolveProjectRef)
const mockResolveWorkspaceRef = vi.mocked(resolveWorkspaceRef)

function createProgram() {
    return createTestProgram(registerTemplateCommand)
}

describe('template', () => {
    let mockApi: MockApi
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = setupApiMock()
        consoleSpy = captureConsole()
        mockResolveProjectRef.mockResolvedValue(fixtures.projects.work)
    })

    describe('export-file (deprecated)', () => {
        it('still exports, and warns to use td project export', async () => {
            const program = createProgram()
            mockApi.exportProjectAsCsv.mockResolvedValue('task,priority\nBuy milk,4')
            const stdoutSpy = captureStream()
            const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

            await program.parseAsync(['node', 'td', 'template', 'export-file', 'Work'])

            expect(mockApi.exportProjectAsCsv).toHaveBeenCalledWith({
                projectId: fixtures.projects.work.id,
                useRelativeDates: undefined,
            })
            expect(stdoutSpy).toHaveBeenCalledWith('task,priority\nBuy milk,4')
            expect(stderrSpy).toHaveBeenCalledWith(
                expect.stringContaining('Warning:'),
                expect.stringContaining('Use `td project export` instead.'),
            )
        })

        it('is hidden from td template --help', () => {
            const program = createProgram()
            const template = program.commands.find((c) => c.name() === 'template')!

            expect(template.helpInformation()).not.toContain('export-file')
        })
    })

    it('points td template --help to the project commands that use a template', () => {
        const template = createProgram().commands.find((c) => c.name() === 'template')!
        let help = ''
        template.configureOutput({ writeOut: (str) => (help += str) })
        template.outputHelp()

        expect(help).toContain('td project create --from-template <id>')
        expect(help).toContain('td project import <project> --from-template <id>')
    })

    describe('export-url', () => {
        it('displays file name and URL', async () => {
            const program = createProgram()
            mockApi.exportTemplateAsUrl.mockResolvedValue({
                fileName: 'template.csv',
                fileUrl: 'https://example.com/template.csv',
            })

            await program.parseAsync(['node', 'td', 'template', 'export-url', 'Work'])

            expect(mockResolveProjectRef).toHaveBeenCalledWith(mockApi, 'Work')
            expect(mockApi.exportTemplateAsUrl).toHaveBeenCalledWith({
                projectId: fixtures.projects.work.id,
                useRelativeDates: undefined,
            })
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('template.csv'))
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('https://example.com/template.csv'),
            )
        })

        it('outputs JSON with --json', async () => {
            const program = createProgram()
            mockApi.exportTemplateAsUrl.mockResolvedValue({
                fileName: 'template.csv',
                fileUrl: 'https://example.com/template.csv',
            })

            await program.parseAsync(['node', 'td', 'template', 'export-url', 'Work', '--json'])

            const output = consoleSpy.mock.calls[0][0] as string
            const parsed = JSON.parse(output)
            expect(parsed.fileName).toBe('template.csv')
            expect(parsed.fileUrl).toBe('https://example.com/template.csv')
        })
    })

    describe('create', () => {
        beforeEach(() => {
            vi.mocked(open).mockResolvedValue({ close: vi.fn() } as unknown as Awaited<
                ReturnType<typeof open>
            >)
            vi.mocked(fs.openAsBlob).mockResolvedValue(new Blob([Buffer.from('template content')]))
        })

        it('creates project from template file', async () => {
            const program = createProgram()
            mockApi.addProjectFromCsv.mockResolvedValue({
                status: 'ok',
                projectId: 'new-proj-1',
                templateType: 'project',
                projects: [],
                sections: [],
                tasks: [fixtures.tasks.basic],
                comments: [],
            })

            await program.parseAsync([
                'node',
                'td',
                'template',
                'create',
                '--name',
                'My Project',
                '--file',
                '/tmp/template.csv',
            ])

            const createArg = mockApi.addProjectFromCsv.mock.calls[0][0]
            expect(createArg).toMatchObject({
                name: 'My Project',
                fileName: 'template.csv',
                workspaceId: undefined,
            })
            expect(createArg.file).toBeInstanceOf(Blob)
            expect(await (createArg.file as Blob).text()).toBe('template content')
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Created project: My Project'),
            )
        })

        it('warns that --file moved to td project create --from-csv', async () => {
            const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

            await createProgram().parseAsync([
                'node',
                'td',
                'template',
                'create',
                '--name',
                'My Project',
                '--file',
                '/tmp/template.csv',
            ])

            expect(mockApi.addProjectFromCsv).toHaveBeenCalled()
            expect(stderrSpy).toHaveBeenCalledWith(
                expect.stringContaining('Warning:'),
                expect.stringContaining('Use `td project create --from-csv` instead.'),
            )
        })

        it('forwards --file-name to api.addProjectFromCsv (overrides basename)', async () => {
            const program = createProgram()
            mockApi.addProjectFromCsv.mockResolvedValue({
                status: 'ok',
                projectId: 'new-proj-1',
                templateType: 'project',
                projects: [],
                sections: [],
                tasks: [],
                comments: [],
            })

            await program.parseAsync([
                'node',
                'td',
                'template',
                'create',
                '--name',
                'My Project',
                '--file',
                '/tmp/template.csv',
                '--file-name',
                'override.csv',
            ])

            const createArg = mockApi.addProjectFromCsv.mock.calls[0][0]
            expect(createArg.fileName).toBe('override.csv')
        })

        it('resolves workspace ref when --workspace is provided', async () => {
            const program = createProgram()
            mockResolveWorkspaceRef.mockResolvedValue({
                id: 'ws-1',
                name: 'My Workspace',
            } as Awaited<ReturnType<typeof resolveWorkspaceRef>>)
            mockApi.addProjectFromCsv.mockResolvedValue({
                status: 'ok',
                projectId: 'new-proj-1',
                templateType: 'project',
                projects: [],
                sections: [],
                tasks: [],
                comments: [],
            })

            await program.parseAsync([
                'node',
                'td',
                'template',
                'create',
                '--name',
                'WS Project',
                '--file',
                '/tmp/template.csv',
                '--workspace',
                'My Workspace',
            ])

            expect(mockResolveWorkspaceRef).toHaveBeenCalledWith('My Workspace')
            expect(mockApi.addProjectFromCsv).toHaveBeenCalledWith(
                expect.objectContaining({ workspaceId: 'ws-1' }),
            )
        })

        it('outputs JSON with --json', async () => {
            const program = createProgram()
            mockApi.addProjectFromCsv.mockResolvedValue({
                status: 'ok',
                projectId: 'new-proj-1',
                templateType: 'project',
                projects: [],
                sections: [],
                tasks: [],
                comments: [],
            })

            await program.parseAsync([
                'node',
                'td',
                'template',
                'create',
                '--name',
                'Test',
                '--file',
                '/tmp/template.csv',
                '--json',
            ])

            const output = consoleSpy.mock.calls[0][0] as string
            const parsed = JSON.parse(output)
            expect(parsed.status).toBe('ok')
            expect(parsed.projectId).toBe('new-proj-1')
        })

        it('shows dry-run preview', async () => {
            const program = createProgram()

            await program.parseAsync([
                'node',
                'td',
                'template',
                'create',
                '--name',
                'Test',
                '--file',
                '/tmp/template.csv',
                '--dry-run',
            ])

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'))
            expect(mockApi.addProjectFromCsv).not.toHaveBeenCalled()
        })

        it('errors when file does not exist', async () => {
            const program = createProgram()
            vi.mocked(open).mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            )

            await expect(
                program.parseAsync([
                    'node',
                    'td',
                    'template',
                    'create',
                    '--name',
                    'Test',
                    '--file',
                    '/tmp/nonexistent.csv',
                ]),
            ).rejects.toThrow('not found')
            // File validation runs before any API/ref work — if a
            // future change reorders that, these mocks would record a
            // call and this test would catch the regression.
            expect(mockGetApi).not.toHaveBeenCalled()
            expect(mockResolveWorkspaceRef).not.toHaveBeenCalled()
        })
    })

    describe('create --from-csv', () => {
        const saved = {
            id: 'UT_new',
            name: 'Onboarding',
            workspaceId: null,
            sharedWithWorkspaceMembers: false,
        } as unknown as Template

        beforeEach(() => {
            vi.mocked(open).mockResolvedValue({ close: vi.fn() } as unknown as Awaited<
                ReturnType<typeof open>
            >)
            vi.mocked(fs.openAsBlob).mockResolvedValue(new Blob([Buffer.from('csv content')]))
            mockApi.addTemplate.mockResolvedValue(saved)
        })

        function run(...args: string[]) {
            return createProgram().parseAsync(['node', 'td', 'template', 'create', ...args])
        }

        it('saves a personal template from the CSV, charcoal by default', async () => {
            await run(
                '--name',
                'Onboarding',
                '--from-csv',
                '/tmp/onboarding.csv',
                '--description',
                'New hires',
            )

            const arg = mockApi.addTemplate.mock.calls[0][0]
            expect(arg).toMatchObject({
                name: 'Onboarding',
                description: 'New hires',
                color: 'charcoal',
                fileName: 'onboarding.csv',
            })
            expect(await (arg.file as Blob).text()).toBe('csv content')
            expect(mockApi.addProjectFromCsv).not.toHaveBeenCalled()
            expect(consoleSpy).toHaveBeenCalledWith('Saved template: Onboarding')
        })

        it('uses --color and --file-name', async () => {
            await run(
                '--name',
                'Onboarding',
                '--from-csv',
                '/tmp/onboarding.csv',
                '--description',
                'x',
                '--color',
                'lime_green',
                '--file-name',
                'Plan.csv',
            )

            expect(mockApi.addTemplate.mock.calls[0][0]).toMatchObject({
                color: 'lime_green',
                fileName: 'Plan.csv',
            })
        })

        it('outputs the saved template with --json', async () => {
            await run('--name', 'O', '--from-csv', '/tmp/o.csv', '--description', 'x', '--json')

            expect(JSON.parse(consoleSpy.mock.calls[0][0] as string).id).toBe('UT_new')
        })

        it('previews with --dry-run without saving', async () => {
            await run('--name', 'O', '--from-csv', '/tmp/o.csv', '--description', 'x', '--dry-run')

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'))
            expect(mockApi.addTemplate).not.toHaveBeenCalled()
        })

        it.each([
            [['--name', 'O', '--description', 'x'], 'INVALID_OPTIONS'],
            [['--name', 'O', '--from-csv', '/tmp/o.csv'], 'INVALID_OPTIONS'],
            [
                [
                    '--name',
                    'O',
                    '--from-csv',
                    '/tmp/o.csv',
                    '--description',
                    'x',
                    '--workspace',
                    'Acme',
                ],
                'INVALID_OPTIONS',
            ],
            [
                ['--name', 'O', '--from-csv', '/tmp/o.csv', '--file', '/tmp/o.csv'],
                'CONFLICTING_OPTIONS',
            ],
            [['--name', 'O', '--file', '/tmp/o.csv', '--description', 'x'], 'INVALID_OPTIONS'],
        ])('rejects %j with %s and saves nothing', async (args, code) => {
            await expect(run(...args)).rejects.toMatchObject({ code })
            expect(mockApi.addTemplate).not.toHaveBeenCalled()
            expect(mockApi.addProjectFromCsv).not.toHaveBeenCalled()
        })
    })

    describe('import-file and import-id (deprecated)', () => {
        let stderrSpy: ReturnType<typeof vi.spyOn>

        beforeEach(() => {
            vi.mocked(open).mockResolvedValue({ close: vi.fn() } as unknown as Awaited<
                ReturnType<typeof open>
            >)
            vi.mocked(fs.openAsBlob).mockResolvedValue(new Blob([Buffer.from('csv content')]))
            stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        })

        it('import-file still imports the CSV, and warns to use td project import --from-csv', async () => {
            await createProgram().parseAsync([
                'node',
                'td',
                'template',
                'import-file',
                'Work',
                '--file',
                '/tmp/roadmap.csv',
                '--file-name',
                'Q2 plan.csv',
            ])

            expect(mockApi.importCsvIntoProject.mock.calls[0][0]).toMatchObject({
                projectId: fixtures.projects.work.id,
                fileName: 'Q2 plan.csv',
            })
            expect(stderrSpy).toHaveBeenCalledWith(
                expect.stringContaining('Warning:'),
                expect.stringContaining('Use `td project import --from-csv` instead.'),
            )
        })

        it('import-id still imports the template, and warns to use td project import --from-template', async () => {
            await createProgram().parseAsync([
                'node',
                'td',
                'template',
                'import-id',
                'Work',
                '--template-id',
                'product-launch',
                '--locale',
                'fr',
            ])

            expect(mockApi.importTemplateFromId).toHaveBeenCalledWith({
                projectId: fixtures.projects.work.id,
                templateId: 'product-launch',
                locale: 'fr',
            })
            expect(stderrSpy).toHaveBeenCalledWith(
                expect.stringContaining('Warning:'),
                expect.stringContaining('Use `td project import --from-template` instead.'),
            )
        })

        it('are hidden from td template --help', () => {
            const template = createProgram().commands.find((c) => c.name() === 'template')!

            expect(template.helpInformation()).not.toMatch(/import-file|import-id/)
        })
    })
})
