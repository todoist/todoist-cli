import { type ColorKey, colors, isWorkspaceProject } from '@todoist/sdk'
import { getApi } from '../../lib/api/core.js'
import { CliError } from '../../lib/errors.js'
import { isQuiet } from '../../lib/global-args.js'
import { printDryRun } from '../../lib/output.js'
import { resolveProjectRef } from '../../lib/refs.js'
import { printSavedTemplate } from '../template/helpers.js'

export interface SaveAsTemplateOptions {
    project?: string
    name?: string
    description: string
    color?: ColorKey
    forWorkspace?: boolean
    json?: boolean
    dryRun?: boolean
}

const TEMPLATE_COLOR_KEYS: readonly string[] = colors.map((c) => c.key)

export async function saveProjectAsTemplate(
    projectRef: string,
    options: SaveAsTemplateOptions,
): Promise<void> {
    const api = await getApi()
    const project = await resolveProjectRef(api, projectRef)

    if (options.forWorkspace && !isWorkspaceProject(project)) {
        throw new CliError(
            'INVALID_OPTIONS',
            '--for-workspace only applies to a workspace project',
            ['Without it, the template is saved to your personal templates.'],
        )
    }

    const name = options.name ?? project.name
    // Default to the project's color, as the app does; a template only takes the named colors.
    const color: ColorKey =
        options.color ??
        (TEMPLATE_COLOR_KEYS.includes(project.color) ? (project.color as ColorKey) : 'charcoal')

    if (options.dryRun) {
        printDryRun('save project as template', {
            Project: project.name,
            Name: name,
            Description: options.description,
            Color: color,
            Saved: options.forWorkspace
                ? "to the project's workspace"
                : 'to your personal templates',
        })
        return
    }

    const template = await api.saveProjectAsTemplate({
        projectId: project.id,
        name,
        description: options.description,
        color,
        forWorkspace: options.forWorkspace,
    })

    if (options.json) {
        console.log(JSON.stringify(template, null, 2))
        return
    }

    if (isQuiet()) {
        console.log(template.id)
        return
    }

    printSavedTemplate(template)
}
