import { captureConsole, createTestProgram } from '@todoist/cli-core/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api/core.js', () => ({
    getApi: vi.fn(),
    getCurrentUserId: vi.fn(),
    getAccountTimezone: vi.fn(async () => 'UTC'),
}))

import { getAccountTimezone, getCurrentUserId } from '../lib/api/core.js'
import { setupApiMock } from '../test-support/api-mock.js'
import { fixtures } from '../test-support/fixtures.js'
import { type MockApi, mockUnjoinedProject } from '../test-support/mock-api.js'
import { registerActivityCommand } from './activity.js'

const mockGetCurrentUserId = vi.mocked(getCurrentUserId)

function createProgram() {
    return createTestProgram(registerActivityCommand)
}

describe('activity command', () => {
    let mockApi: MockApi
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = setupApiMock()
        mockGetCurrentUserId.mockResolvedValue('user-123')
        consoleSpy = captureConsole()
    })

    it('shows activity events', async () => {
        const program = createProgram()

        mockApi.getActivityLogs.mockResolvedValue({
            results: [
                {
                    id: 'event-1',
                    objectType: 'task',
                    objectId: 'task-1',
                    eventType: 'completed',
                    eventDate: new Date('2025-01-10T14:30:00Z'),
                    parentProjectId: 'proj-1',
                    parentItemId: null,
                    initiatorId: 'user-1',
                    extraData: { content: 'Buy groceries' },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Shopping' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'activity'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Activity'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('completed'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Buy groceries'))
    })

    it('does not split an emoji when truncating long activity content', async () => {
        // The call-site guard for `truncateContent`. The default limit is 100 and
        // the cut lands at 97, so this content puts a palm tree exactly across
        // that boundary, which is where a code-unit slice used to bisect it.
        const straddling = `${'x'.repeat(96)}\u{1F334} and more text past the limit`
        const program = createProgram()

        mockApi.getActivityLogs.mockResolvedValue({
            results: [
                {
                    id: 'event-1',
                    objectType: 'task',
                    objectId: 'task-1',
                    eventType: 'added',
                    eventDate: new Date('2025-01-10T14:30:00Z'),
                    parentProjectId: 'proj-1',
                    parentItemId: null,
                    initiatorId: 'user-1',
                    extraData: { content: straddling },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Shopping' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'activity'])

        const printed = consoleSpy.mock.calls.flat().join('\n')
        expect(printed.isWellFormed()).toBe(true)
        // It truncated (so the guard is exercised) and kept the emoji whole.
        expect(printed).toContain('...')
        expect(printed).toContain('\u{1F334}')
    })

    it('shows "No activity found" when empty', async () => {
        const program = createProgram()

        mockApi.getActivityLogs.mockResolvedValue({
            results: [],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'activity'])

        expect(consoleSpy).toHaveBeenCalledWith('No activity found.')
    })

    it('filters by object type', async () => {
        const program = createProgram()

        await program.parseAsync(['node', 'td', 'activity', '--type', 'task'])

        expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                objectEventTypes: 'task:',
            }),
        )
    })

    it('filters by event type', async () => {
        const program = createProgram()

        await program.parseAsync(['node', 'td', 'activity', '--event', 'completed'])

        expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                objectEventTypes: ':completed',
            }),
        )
    })

    describe('--since and --until', () => {
        function runActivity(...flags: string[]) {
            return createProgram().parseAsync(['node', 'td', 'activity', ...flags])
        }

        it('asks for whole days, from the start of --since to the end of --until', async () => {
            await runActivity('--since', '2025-01-01', '--until', '2025-01-10')

            expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    dateFrom: '2025-01-01T00:00:00Z',
                    dateTo: '2025-01-11T00:00:00Z',
                }),
            )
        })

        it("reads the days in the account's time zone", async () => {
            vi.mocked(getAccountTimezone).mockResolvedValueOnce('America/Chicago')

            await runActivity('--since', '2025-01-01', '--until', '2025-01-10')

            expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    dateFrom: '2025-01-01T06:00:00Z',
                    dateTo: '2025-01-11T06:00:00Z',
                }),
            )
        })

        it('covers a single day when --since and --until are the same', async () => {
            vi.mocked(getAccountTimezone).mockResolvedValueOnce('America/New_York')

            // Clocks go forward on 8 March 2026, so this day is 23 hours long.
            await runActivity('--since', '2026-03-08', '--until', '2026-03-08')

            expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    dateFrom: '2026-03-08T05:00:00Z',
                    dateTo: '2026-03-09T04:00:00Z',
                }),
            )
        })

        it('takes either flag on its own', async () => {
            await runActivity('--since', '2025-01-01')
            await runActivity('--until', '2025-01-10')

            const [[sinceOnly], [untilOnly]] = mockApi.getActivityLogs.mock.calls
            expect(sinceOnly).toMatchObject({ dateFrom: '2025-01-01T00:00:00Z', dateTo: undefined })
            expect(untilOnly).toMatchObject({ dateFrom: undefined, dateTo: '2025-01-11T00:00:00Z' })
        })

        it('looks the time zone up alongside the other lookups', async () => {
            let deliverTimezone: (timezone: string) => void = () => {}
            vi.mocked(getAccountTimezone).mockReturnValueOnce(
                new Promise((resolve) => {
                    deliverTimezone = resolve
                }),
            )
            mockGetCurrentUserId.mockResolvedValue('user-123')

            const run = runActivity('--since', '2025-01-01', '--by', 'me')
            await vi.waitFor(() => expect(mockGetCurrentUserId).toHaveBeenCalled())
            deliverTimezone('UTC')
            await run

            expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
                expect.objectContaining({
                    dateFrom: '2025-01-01T00:00:00Z',
                    initiatorId: 'user-123',
                }),
            )
        })

        it('does not look the time zone up without them', async () => {
            await runActivity()

            expect(getAccountTimezone).not.toHaveBeenCalled()
            expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
                expect.objectContaining({ dateFrom: undefined, dateTo: undefined }),
            )
        })

        it('rejects an --until before --since before calling the API', async () => {
            await expect(
                runActivity('--since', '2025-01-10', '--until', '2025-01-09'),
            ).rejects.toMatchObject({
                code: 'INVALID_DATE_RANGE',
                message: '--until must not be before --since',
            })
            expect(mockApi.getActivityLogs).not.toHaveBeenCalled()
        })

        it('accepts a year and rejects a longer range before calling the API', async () => {
            await runActivity('--since', '2025-01-01', '--until', '2025-12-31')
            expect(mockApi.getActivityLogs).toHaveBeenCalledTimes(1)

            await expect(
                runActivity('--since', '2025-01-01', '--until', '2026-01-01'),
            ).rejects.toMatchObject({
                code: 'INVALID_DATE_RANGE',
                message: 'Activity date ranges cannot exceed 365 days',
            })
            expect(mockApi.getActivityLogs).toHaveBeenCalledTimes(1)
        })
    })

    it.each([
        ['a written-out date', ['--since', 'Jan 1 2025'], 'Invalid --since date: "Jan 1 2025"'],
        ['an unpadded date', ['--since', '2025-1-5'], 'Invalid --since date: "2025-1-5"'],
        ['an impossible date', ['--until', '2025-02-30'], 'Invalid --until date: "2025-02-30"'],
        [
            'a date and time',
            ['--until', '2025-01-10T09:00'],
            'Invalid --until date: "2025-01-10T09:00"',
        ],
    ])('rejects %s before calling the API', async (_, flags, message) => {
        await expect(
            createProgram().parseAsync(['node', 'td', 'activity', ...flags]),
        ).rejects.toMatchObject({ code: 'INVALID_DATE', message })
        expect(mockApi.getActivityLogs).not.toHaveBeenCalled()
    })

    it('filters by project', async () => {
        const program = createProgram()

        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'activity', '--project', 'Work'])

        expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                parentProjectId: 'proj-1',
            }),
        )
    })

    it('filters by a workspace project the user has not joined', async () => {
        mockUnjoinedProject(mockApi, fixtures.projects.unjoined)

        await createProgram().parseAsync(['node', 'td', 'activity', '--project', 'id:unjoined1'])

        expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
            expect.objectContaining({ parentProjectId: 'unjoined1' }),
        )
    })

    it('names the project and initiator of an unjoined workspace project', async () => {
        mockUnjoinedProject(mockApi, fixtures.projects.unjoined)
        mockApi.getActivityLogs.mockResolvedValue({
            results: [
                {
                    id: 'event-1',
                    objectType: 'task',
                    objectId: 'task-1',
                    eventType: 'completed',
                    eventDate: new Date('2025-01-10T14:30:00Z'),
                    parentProjectId: 'unjoined1',
                    parentItemId: null,
                    initiatorId: 'user-1',
                    extraData: { content: 'Ship it' },
                },
            ],
            nextCursor: null,
        })
        mockApi.getWorkspaceUsers.mockResolvedValue({
            workspaceUsers: [
                { userId: 'user-1', fullName: 'Alice Smith', userEmail: 'alice@example.com' },
            ],
            hasMore: false,
        })

        await createProgram().parseAsync(['node', 'td', 'activity', '--project', 'id:unjoined1'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Other Team Backlog'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('by Alice S.'))
    })

    it('filters by initiator with "me"', async () => {
        const program = createProgram()

        await program.parseAsync(['node', 'td', 'activity', '--by', 'me'])

        expect(mockGetCurrentUserId).toHaveBeenCalled()
        expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                initiatorId: 'user-123',
            }),
        )
    })

    it('filters by initiator with id: prefix', async () => {
        const program = createProgram()

        await program.parseAsync(['node', 'td', 'activity', '--by', 'id:user-456'])

        expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                initiatorId: 'user-456',
            }),
        )
    })

    it('outputs JSON with --json flag', async () => {
        const program = createProgram()

        mockApi.getActivityLogs.mockResolvedValue({
            results: [
                {
                    id: 'event-1',
                    objectType: 'task',
                    objectId: 'task-1',
                    eventType: 'added',
                    eventDate: new Date('2025-01-10T14:30:00Z'),
                    parentProjectId: null,
                    parentItemId: null,
                    initiatorId: null,
                    extraData: null,
                },
            ],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'activity', '--json'])

        const output = consoleSpy.mock.calls[0][0]
        const parsed = JSON.parse(output)
        expect(parsed.results).toBeDefined()
        expect(parsed.results[0].eventType).toBe('added')
    })

    it('outputs NDJSON with --ndjson flag', async () => {
        const program = createProgram()

        mockApi.getActivityLogs.mockResolvedValue({
            results: [
                {
                    id: 'event-1',
                    objectType: 'task',
                    objectId: 'task-1',
                    eventType: 'added',
                    eventDate: new Date('2025-01-10T14:30:00Z'),
                    parentProjectId: null,
                    parentItemId: null,
                    initiatorId: null,
                    extraData: null,
                },
                {
                    id: 'event-2',
                    objectType: 'task',
                    objectId: 'task-2',
                    eventType: 'completed',
                    eventDate: new Date('2025-01-10T14:35:00Z'),
                    parentProjectId: null,
                    parentItemId: null,
                    initiatorId: null,
                    extraData: null,
                },
            ],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'activity', '--ndjson'])

        const output = consoleSpy.mock.calls[0][0]
        const lines = output.split('\n')
        expect(lines).toHaveLength(2)
    })

    it('rejects conflicting output format flags', async () => {
        const program = createProgram()

        await expect(
            program.parseAsync(['node', 'td', 'activity', '--json', '--ndjson']),
        ).rejects.toThrow('mutually exclusive')
    })

    it('respects --limit option', async () => {
        const program = createProgram()

        await program.parseAsync(['node', 'td', 'activity', '--limit', '25'])

        expect(mockApi.getActivityLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                limit: 25,
            }),
        )
    })

    it('includes project names in text output', async () => {
        const program = createProgram()

        mockApi.getActivityLogs.mockResolvedValue({
            results: [
                {
                    id: 'event-1',
                    objectType: 'task',
                    objectId: 'task-1',
                    eventType: 'added',
                    eventDate: new Date('2025-01-10T14:30:00Z'),
                    parentProjectId: 'proj-1',
                    parentItemId: null,
                    initiatorId: null,
                    extraData: { content: 'Test task' },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'activity'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Work'))
    })

    it('shows cursor hint instead of --all when more items exist', async () => {
        const mockEvent = {
            id: 'event-1',
            objectType: 'task',
            objectId: 'task-1',
            eventType: 'added',
            eventDate: new Date('2025-01-10T14:30:00Z'),
            parentProjectId: 'proj-1',
            parentItemId: null,
            initiatorId: null,
            extraData: { content: 'Test task' },
        }
        const mockProjects = { results: [{ id: 'proj-1', name: 'Work' }], nextCursor: null }

        mockApi.getActivityLogs.mockResolvedValue({
            results: [mockEvent],
            nextCursor: 'cursor-abc',
        })
        mockApi.getProjects.mockResolvedValue(mockProjects)

        const program = createProgram()
        await program.parseAsync(['node', 'td', 'activity'])

        const textOutput = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n')
        expect(textOutput).toContain('--cursor')
        expect(textOutput).not.toContain('--all')
    })
})
