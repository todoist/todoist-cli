import { getApi } from '../../lib/api/core.js'
import type { Project } from '../../lib/api/core.js'
import { resolveProjectRef, resolveTaskRef } from '../../lib/refs.js'
import { listTasksForProject, type TaskListOptions } from '../../lib/task-list.js'

export type ListOptions = TaskListOptions & { project?: string }

export async function listTasks(options: ListOptions): Promise<void> {
    const api = await getApi()

    let project: Project | undefined
    if (options.project) {
        project = await resolveProjectRef(api, options.project, { includeUnjoined: true })
    }
    let projectId = project?.id ?? null

    let parentId: string | undefined
    if (options.parent) {
        const parentTask = await resolveTaskRef(api, options.parent)
        parentId = parentTask.id
        if (!projectId) projectId = parentTask.projectId
    }

    await listTasksForProject(projectId, { ...options, parent: parentId }, project)
}
