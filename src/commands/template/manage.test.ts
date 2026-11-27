import { readFile } from 'node:fs/promises'
import { captureConsole, createTestProgram } from '@todoist/cli-core/testing'
import type { Template, TemplateContentResponse } from '@todoist/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, readFile: vi.fn() }
})
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

import { resolveProjectRef, resolveWorkspaceRef } from '../../lib/refs.js'
import { setupApiMock } from '../../test-support/api-mock.js'
import { fixtures } from '../../test-support/fixtures.js'
import { type MockApi } from '../../test-support/mock-api.js'
import { registerTemplateCommand } from './index.js'

function template(overrides: Partial<Template>): Template {
    return {
        id: 'UT_1',
        name: 'Onboarding',
        templateType: 'project',
        templateSource: 'user',
        shortDescription: 'Steps for a new hire',
        workspaceId: null,
        sharedWithWorkspaceMembers: false,
        canEdit: true,
        coverImage: 'https://example.com/cover.png',
        ...overrides,
    } as unknown as Template
}

const content: TemplateContentResponse = {
    templateType: 'project',
    workspaceId: null,
    content: {
        projects: [{ viewStyle: 'list' }],
        sections: [{ id: 's1', name: 'Week 1' }],
        tasks: [
            { id: 't1', content: 'Read the handbook' },
            { id: 't2', content: 'Meet the team', sectionId: 's1' },
            { id: 't3', content: 'Book the lunch', sectionId: 's1', parentId: 't2' },
        ],
        comments: [],
        projectComments: [],
        projectViewOptionsDefaults: [],
    },
} as unknown as TemplateContentResponse

function run(...args: string[]) {
    return createTestProgram(registerTemplateCommand).parseAsync([
        'node',
        'td',
        'template',
        ...args,
    ])
}

describe('template list, view and update', () => {
    let mockApi: MockApi
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = setupApiMock()
        consoleSpy = captureConsole()
    })

    describe('list', () => {
        beforeEach(() => {
            mockApi.getTemplates.mockResolvedValue({
                results: [
                    template({}),
                    template({
                        id: 'UT_2',
                        name: 'Sprint',
                        workspaceId: 'ws-1',
                        sharedWithWorkspaceMembers: true,
                    }),
                    template({
                        id: 'product-launch',
                        name: 'Product Launch',
                        templateSource: 'todoist',
                    }),
                ],
                nextCursor: null,
            })
        })

        it('lists every source by default, labelling each', async () => {
            await run('list')

            expect(mockApi.getTemplates).toHaveBeenCalledWith(
                expect.objectContaining({ templateSource: 'all', query: undefined }),
            )
            const lines: string[] = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]))
            expect(lines.some((l) => l.includes('Onboarding') && l.includes('(personal)'))).toBe(
                true,
            )
            expect(
                lines.some(
                    (l) => l.includes('Sprint') && l.includes('(workspace, shared with members)'),
                ),
            ).toBe(true)
            expect(lines.some((l) => l.includes('Product Launch') && l.includes('(gallery)'))).toBe(
                true,
            )
        })

        it.each([
            ['personal', 'user'],
            ['workspace', 'workspace'],
            ['gallery', 'todoist'],
        ])('maps --source %s to %s, with --search', async (source, filter) => {
            await run('list', '--source', source, '--search', 'launch')

            expect(mockApi.getTemplates).toHaveBeenCalledWith(
                expect.objectContaining({ templateSource: filter, query: 'launch' }),
            )
        })

        it('outputs essential fields with --json, and everything with --full', async () => {
            await run('list', '--json')
            const essential = JSON.parse(consoleSpy.mock.calls[0][0] as string)
            expect(essential.results[0]).toEqual({
                id: 'UT_1',
                name: 'Onboarding',
                templateType: 'project',
                templateSource: 'user',
                shortDescription: 'Steps for a new hire',
                workspaceId: null,
                sharedWithWorkspaceMembers: false,
                canEdit: true,
            })

            consoleSpy.mockClear()
            await run('list', '--json', '--full')
            const full = JSON.parse(consoleSpy.mock.calls[0][0] as string)
            expect(full.results[0].coverImage).toBe('https://example.com/cover.png')
        })
    })

    describe('view', () => {
        beforeEach(() => {
            mockApi.getTemplate.mockResolvedValue(template({}))
            mockApi.getTemplateContent.mockResolvedValue(content)
        })

        it('shows the template without its content by default', async () => {
            await run('view', 'UT_1')

            expect(mockApi.getTemplate).toHaveBeenCalledWith('UT_1', { locale: undefined })
            expect(mockApi.getTemplateContent).not.toHaveBeenCalled()
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Onboarding'))
            expect(consoleSpy).toHaveBeenCalledWith('Steps for a new hire')
        })

        it('shows sections and nested tasks with --content', async () => {
            await run('view', 'UT_1', '--content')

            const lines: string[] = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]))
            expect(lines).toContain('- Read the handbook')
            expect(lines).toContain('- Meet the team')
            expect(lines).toContain('  - Book the lunch')
            expect(lines.some((l) => l.includes('Week 1'))).toBe(true)
        })

        it('includes the content in --json, ready for update --content-file', async () => {
            await run('view', 'UT_1', '--content', '--json')

            const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)
            expect(parsed.id).toBe('UT_1')
            expect(parsed.content).toEqual(content.content)
        })
    })

    describe('update', () => {
        beforeEach(() => {
            mockApi.updateTemplate.mockResolvedValue(template({ name: 'Onboarding v2' }))
            vi.mocked(resolveWorkspaceRef).mockResolvedValue({
                id: 'ws-1',
                name: 'Acme',
            } as Awaited<ReturnType<typeof resolveWorkspaceRef>>)
            vi.mocked(resolveProjectRef).mockResolvedValue(fixtures.projects.work)
        })

        it('sends only the fields given', async () => {
            await run('update', 'UT_1', '--name', 'Onboarding v2', '--color', 'lime_green')

            expect(mockApi.updateTemplate).toHaveBeenCalledWith('UT_1', {
                name: 'Onboarding v2',
                description: undefined,
                color: 'lime_green',
                workspaceId: undefined,
                sharedWithWorkspaceMembers: undefined,
                projectId: undefined,
                content: undefined,
            })
            expect(consoleSpy).toHaveBeenCalledWith('Updated template: Onboarding v2')
        })

        it('moves to a workspace and shares with --workspace and --share', async () => {
            await run('update', 'UT_1', '--workspace', 'Acme', '--share')

            expect(mockApi.updateTemplate).toHaveBeenCalledWith(
                'UT_1',
                expect.objectContaining({ workspaceId: 'ws-1', sharedWithWorkspaceMembers: true }),
            )
        })

        it('stops sharing with --no-share', async () => {
            await run('update', 'UT_1', '--no-share')

            expect(mockApi.updateTemplate).toHaveBeenCalledWith(
                'UT_1',
                expect.objectContaining({ sharedWithWorkspaceMembers: false }),
            )
        })

        it("replaces the content with a project's with --from-project", async () => {
            await run('update', 'UT_1', '--from-project', 'Work')

            expect(mockApi.updateTemplate).toHaveBeenCalledWith(
                'UT_1',
                expect.objectContaining({ projectId: fixtures.projects.work.id }),
            )
        })

        it('replaces the content from the JSON of view --content --json', async () => {
            vi.mocked(readFile).mockResolvedValue(
                JSON.stringify({ id: 'UT_1', content: content.content }),
            )

            await run('update', 'UT_1', '--content-file', '/tmp/onboarding.json')

            expect(mockApi.updateTemplate).toHaveBeenCalledWith(
                'UT_1',
                expect.objectContaining({ content: content.content }),
            )
        })

        it.each([
            ['not json', 'INVALID_JSON'],
            [JSON.stringify({ name: 'no content' }), 'INVALID_INPUT'],
        ])('rejects a content file of %j with %s', async (text, code) => {
            vi.mocked(readFile).mockResolvedValue(text)

            await expect(
                run('update', 'UT_1', '--content-file', '/tmp/x.json'),
            ).rejects.toMatchObject({
                code,
            })
            expect(mockApi.updateTemplate).not.toHaveBeenCalled()
        })

        it.each([
            [['update', 'UT_1'], 'NO_CHANGES'],
            [
                ['update', 'UT_1', '--from-project', 'Work', '--content-file', '/tmp/x.json'],
                'CONFLICTING_OPTIONS',
            ],
        ])('rejects %j with %s', async (args, code) => {
            await expect(run(...args)).rejects.toMatchObject({ code })
            expect(mockApi.updateTemplate).not.toHaveBeenCalled()
        })

        it('previews with --dry-run without updating', async () => {
            await run('update', 'UT_1', '--name', 'X', '--dry-run')

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'))
            expect(mockApi.updateTemplate).not.toHaveBeenCalled()
        })
    })
})
