import { outputIds, resolveOutputMode } from '@todoist/cli-core'
import chalk from 'chalk'
import { getAccountTimezone, getApi, type Project, type Task } from '../../lib/api/core.js'
import { CollaboratorCache, formatAssignee } from '../../lib/collaborators.js'
import {
    addDays,
    formatDateInTimezone,
    parseDateOption,
    startOfDayInTimezone,
    toApiInstant,
} from '../../lib/dates.js'
import { CliError } from '../../lib/errors.js'
import type { PaginatedViewOptions } from '../../lib/options.js'
import {
    formatNextCursorFooter,
    formatNextCursorNotice,
    formatPaginatedJson,
    formatPaginatedNdjson,
    formatTaskRow,
} from '../../lib/output.js'
import { LIMITS, paginate } from '../../lib/pagination.js'
import { resolveProjectRef } from '../../lib/refs.js'

interface CompletedListOptions extends PaginatedViewOptions {
    since?: string
    until?: string
    project?: string
    search?: string
}

const MAX_COMPLETION_DATE_RANGE_DAYS = 93
const DAY_IN_MS = 24 * 60 * 60 * 1000

function validateCompletionDateRange(since: string, until: string): void {
    const sinceTimestamp = parseDateOption(since, '--since')
    const untilTimestamp = parseDateOption(until, '--until')
    const rangeDays = (untilTimestamp - sinceTimestamp) / DAY_IN_MS

    if (rangeDays <= 0) {
        throw new CliError('INVALID_DATE_RANGE', '--until must be later than --since', [
            `Received --since ${since} --until ${until}`,
        ])
    }

    if (rangeDays > MAX_COMPLETION_DATE_RANGE_DAYS) {
        const suggestedSince = new Date(untilTimestamp - MAX_COMPLETION_DATE_RANGE_DAYS * DAY_IN_MS)
            .toISOString()
            .slice(0, 10)
        throw new CliError(
            'INVALID_DATE_RANGE',
            'Completed-task date ranges cannot exceed 3 months',
            [
                `Retry the same command with --since ${suggestedSince} --until ${until} for the most recent ${MAX_COMPLETION_DATE_RANGE_DAYS}-day segment.`,
            ],
        )
    }
}

export async function listCompleted(options: CompletedListOptions): Promise<void> {
    const outputMode = resolveOutputMode(options)
    const isSearch = options.search !== undefined

    if (isSearch && !options.search) {
        throw new CliError('INVALID_SEARCH', 'Search query cannot be empty')
    }

    if (isSearch && (options.since || options.until || options.project)) {
        throw new CliError(
            'CONFLICTING_OPTIONS',
            'Cannot use --since, --until, or --project with --search',
        )
    }

    const targetLimit = options.all
        ? Number.MAX_SAFE_INTEGER
        : options.limit
          ? parseInt(options.limit, 10)
          : LIMITS.tasks

    // The days are the account's: today by default, and each day starting at the account's
    // midnight. The API reads a bare date as UTC midnight, so the days are sent as instants.
    const timezone = isSearch ? undefined : await getAccountTimezone()
    const today = isSearch ? undefined : formatDateInTimezone(new Date(), timezone)
    const since = isSearch ? undefined : (options.since ?? today)
    const until = isSearch ? undefined : (options.until ?? (today && addDays(today, 1)))

    if (!isSearch) {
        validateCompletionDateRange(since!, until!)
    }

    const api = await getApi()

    const project =
        !isSearch && options.project
            ? await resolveProjectRef(api, options.project, { includeUnjoined: true })
            : undefined
    const projectId = project?.id

    const { results: tasks, nextCursor } = await paginate(
        async (cursor, limit) => {
            if (isSearch) {
                const resp = await api.searchCompletedTasks({
                    query: options.search!,
                    cursor: cursor ?? undefined,
                    limit,
                })
                return { results: resp.items, nextCursor: resp.nextCursor }
            }
            const resp = await api.getCompletedTasksByCompletionDate({
                since: toApiInstant(startOfDayInTimezone(since!, timezone)),
                until: toApiInstant(startOfDayInTimezone(until!, timezone)),
                projectId,
                cursor: cursor ?? undefined,
                limit,
            })
            return { results: resp.items, nextCursor: resp.nextCursor }
        },
        { limit: targetLimit, startCursor: options.cursor },
    )

    if (outputMode === 'ids-only') {
        outputIds(tasks, (task) => task.id, formatNextCursorNotice(nextCursor))
        return
    }

    if (tasks.length === 0) {
        if (outputMode === 'json') {
            console.log(
                formatPaginatedJson(
                    { results: [], nextCursor },
                    'task',
                    options.full,
                    options.showUrls,
                ),
            )
        } else if (outputMode === 'ndjson') {
            console.log(
                formatPaginatedNdjson(
                    { results: [], nextCursor },
                    'task',
                    options.full,
                    options.showUrls,
                ),
            )
        } else {
            console.log(
                isSearch ? 'No matching completed tasks.' : 'No completed tasks in this period.',
            )
            console.log(formatNextCursorFooter(nextCursor))
        }
        return
    }

    const { results: allProjects } = await api.getProjects()
    const projects = new Map<string, Project>(allProjects.map((p) => [p.id, p]))
    // A workspace project the user hasn't joined isn't in their project list.
    if (project) projects.set(project.id, project)

    const collaboratorCache = new CollaboratorCache()
    await collaboratorCache.preload(api, tasks, projects)

    const getAssigneeName = (task: Task): string | null => {
        return formatAssignee({
            userId: task.responsibleUid,
            projectId: task.projectId,
            projects,
            cache: collaboratorCache,
        })
    }

    if (outputMode === 'json') {
        const tasksWithAssignee = tasks.map((task) => ({
            ...task,
            responsibleName: getAssigneeName(task),
        }))
        console.log(
            formatPaginatedJson(
                { results: tasksWithAssignee, nextCursor },
                'task',
                options.full,
                options.showUrls,
            ),
        )
        return
    }

    if (outputMode === 'ndjson') {
        const tasksWithAssignee = tasks.map((task) => ({
            ...task,
            responsibleName: getAssigneeName(task),
        }))
        console.log(
            formatPaginatedNdjson(
                { results: tasksWithAssignee, nextCursor },
                'task',
                options.full,
                options.showUrls,
            ),
        )
        return
    }

    const header = isSearch
        ? chalk.bold(`Completed (${tasks.length}) - search: "${options.search}"`)
        : chalk.bold(
              `Completed (${tasks.length}) - ${since === until ? since : `${since} to ${until}`}`,
          )
    console.log(header)
    console.log('')

    for (const task of tasks) {
        const projectName = projects.get(task.projectId)?.name
        console.log(
            await formatTaskRow({
                task,
                projectName,
                assignee: getAssigneeName(task) ?? undefined,
                showUrl: options.showUrls,
            }),
        )
        console.log('')
    }
    console.log(formatNextCursorFooter(nextCursor))
}
