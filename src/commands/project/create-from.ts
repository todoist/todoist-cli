import chalk from 'chalk'
import { getApi } from '../../lib/api/core.js'
import { CliError } from '../../lib/errors.js'
import { isQuiet } from '../../lib/global-args.js'
import { openLocalFileAsBlob } from '../../lib/local-file.js'
import { formatJson, printDryRun } from '../../lib/output.js'
import { ensurePersonalProjectCapacity } from '../../lib/project-limit.js'
import { resolveFolderRef, resolveWorkspaceRef } from '../../lib/refs.js'
import { formatImportResult } from './import.js'

export interface CreateFromOptions {
    name?: string
    fromCsv?: string
    fromTemplate?: string
    fileName?: string
    locale?: string
    workspace?: string
    folder?: string
    // Plain `td project create` options, rejected with a source.
    color?: string
    icon?: string
    favorite?: boolean
    parent?: string
    viewStyle?: string
    description?: string
    stdin?: boolean
    json?: boolean
    dryRun?: boolean
}

const PLAIN_ONLY_OPTIONS = [
    ['color', '--color'],
    ['icon', '--icon'],
    ['favorite', '--favorite'],
    ['parent', '--parent'],
    ['viewStyle', '--view-style'],
    ['description', '--description'],
    ['stdin', '--stdin'],
] as const

export function hasCreateSource(options: CreateFromOptions): boolean {
    return Boolean(options.fromCsv || options.fromTemplate)
}

/**
 * Checks the options a source accepts before anything is read or sent. The routes
 * that create from a source take only a name, a workspace and (from a template) a
 * folder and a locale, so other options are rejected rather than ignored.
 */
export function validateCreateFrom(options: CreateFromOptions): void {
    if (options.fromCsv && options.fromTemplate) {
        throw new CliError(
            'CONFLICTING_OPTIONS',
            'Use either --from-csv or --from-template, not both',
        )
    }
    if (!hasCreateSource(options)) {
        for (const [key, flag] of [
            ['workspace', '--workspace'],
            ['folder', '--folder'],
            ['fileName', '--file-name'],
            ['locale', '--locale'],
        ] as const) {
            if (options[key] !== undefined) {
                throw new CliError(
                    'INVALID_OPTIONS',
                    `${flag} only applies with --from-csv or --from-template`,
                )
            }
        }
        return
    }
    const unsupported = PLAIN_ONLY_OPTIONS.filter(([key]) => options[key] !== undefined).map(
        ([, flag]) => flag,
    )
    if (unsupported.length > 0) {
        throw new CliError(
            'INVALID_OPTIONS',
            `${unsupported.join(', ')} can't be used with --from-csv or --from-template`,
            ['Create the project first, then set them with: td project update <ref> ...'],
        )
    }
    if (options.fromCsv) {
        if (!options.name) {
            throw new CliError(
                'MISSING_NAME',
                'A project name is required with --from-csv (--name)',
            )
        }
        if (options.folder) {
            throw new CliError('INVALID_OPTIONS', '--folder only applies with --from-template')
        }
        if (options.locale) {
            throw new CliError('INVALID_OPTIONS', '--locale only applies with --from-template')
        }
    }
    if (options.fromTemplate && options.fileName) {
        throw new CliError('INVALID_OPTIONS', '--file-name only applies with --from-csv')
    }
    if (options.folder && !options.workspace) {
        throw new CliError('INVALID_OPTIONS', '--folder needs --workspace', [
            'Folders belong to a workspace: td project create --from-template <id> --workspace "Acme" --folder "Engineering"',
        ])
    }
}

export async function createProjectFrom(options: CreateFromOptions): Promise<void> {
    validateCreateFrom(options)

    const csv = options.fromCsv
        ? await openLocalFileAsBlob({ file: options.fromCsv, fileName: options.fileName })
        : undefined

    if (options.dryRun) {
        printDryRun(csv ? 'create project from CSV' : 'create project from template', {
            Name: options.name,
            CSV: csv?.filePath,
            'File name': options.fileName,
            Template: options.fromTemplate,
            Locale: options.locale,
            Workspace: options.workspace,
            Folder: options.folder,
        })
        return
    }

    const api = await getApi()

    const workspace = options.workspace ? await resolveWorkspaceRef(options.workspace) : undefined
    const folder =
        workspace && options.folder
            ? await resolveFolderRef(options.folder, workspace.id)
            : undefined
    if (!workspace) {
        await ensurePersonalProjectCapacity(api)
    }

    let projectId: string
    let imported: Awaited<ReturnType<typeof api.addProjectFromCsv>> | undefined
    if (csv) {
        imported = await api.addProjectFromCsv({
            name: options.name as string,
            file: csv.blob,
            fileName: csv.fileName,
            workspaceId: workspace?.id,
        })
        projectId = imported.projectId
    } else {
        const result = await api.addProjectFromTemplateId({
            templateId: options.fromTemplate as string,
            name: options.name,
            locale: options.locale,
            workspaceId: workspace?.id,
            folderId: folder?.id,
        })
        projectId = result.projectId
    }

    const project = await api.getProject(projectId)

    if (options.json) {
        console.log(formatJson(project, 'project'))
        return
    }

    if (isQuiet()) {
        console.log(project.id)
        return
    }

    console.log(`Created: ${project.name}`)
    console.log(chalk.dim(`ID: ${project.id}`))
    if (imported) {
        formatImportResult(imported)
    }
}
