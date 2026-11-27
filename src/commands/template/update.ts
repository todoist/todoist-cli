import type { ColorKey, TemplateContent, UpdateTemplateArgs } from '@todoist/sdk'
import { getApi } from '../../lib/api/core.js'
import { CliError } from '../../lib/errors.js'
import { isQuiet } from '../../lib/global-args.js'
import { readLocalTextFile } from '../../lib/local-file.js'
import { printDryRun } from '../../lib/output.js'
import { resolveProjectRef, resolveWorkspaceRef } from '../../lib/refs.js'
import { printSavedTemplate } from './helpers.js'

export interface UpdateTemplateOptions {
    name?: string
    description?: string
    color?: ColorKey
    workspace?: string
    share?: boolean
    fromProject?: string
    contentFile?: string
    json?: boolean
    dryRun?: boolean
}

export async function updateTemplate(id: string, options: UpdateTemplateOptions): Promise<void> {
    if (options.fromProject && options.contentFile) {
        throw new CliError(
            'CONFLICTING_OPTIONS',
            'Use either --from-project or --content-file, not both',
        )
    }
    const hasChange = [
        options.name,
        options.description,
        options.color,
        options.workspace,
        options.share,
        options.fromProject,
        options.contentFile,
    ].some((value) => value !== undefined)
    if (!hasChange) {
        throw new CliError('NO_CHANGES', 'Nothing to update', [
            'Pass --name, --description, --color, --workspace, --share/--no-share, --from-project or --content-file',
        ])
    }

    const content = options.contentFile ? await readContentFile(options.contentFile) : undefined

    if (options.dryRun) {
        printDryRun('update template', {
            Template: id,
            Name: options.name,
            Description: options.description,
            Color: options.color,
            'Move to workspace': options.workspace,
            'Shared with members':
                options.share === undefined ? undefined : options.share ? 'yes' : 'no',
            'Replace content from project': options.fromProject,
            'Replace content from file': options.contentFile,
        })
        return
    }

    const api = await getApi()
    const [workspace, project] = await Promise.all([
        options.workspace ? resolveWorkspaceRef(options.workspace) : undefined,
        options.fromProject ? resolveProjectRef(api, options.fromProject) : undefined,
    ])

    const args: UpdateTemplateArgs = {
        name: options.name,
        description: options.description,
        color: options.color,
        workspaceId: workspace?.id,
        sharedWithWorkspaceMembers: options.share,
        projectId: project?.id,
        content,
    }
    const template = await api.updateTemplate(id, args)

    if (options.json) {
        console.log(JSON.stringify(template, null, 2))
        return
    }

    if (isQuiet()) {
        console.log(template.id)
        return
    }

    printSavedTemplate(template, 'Updated template')
}

/**
 * Reads template content as JSON: either the content itself, or the whole
 * `td template view <id> --content --json` output, which carries it under `content`.
 */
async function readContentFile(file: string): Promise<TemplateContent> {
    const text = await readLocalTextFile(file)
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        throw new CliError('INVALID_JSON', `${file} is not valid JSON`, [
            "Get a template's content with: td template view <id> --content --json",
        ])
    }
    const content =
        parsed && typeof parsed === 'object' && 'content' in parsed
            ? (parsed as { content: unknown }).content
            : parsed
    if (
        !content ||
        typeof content !== 'object' ||
        !Array.isArray((content as Partial<TemplateContent>).tasks) ||
        !Array.isArray((content as Partial<TemplateContent>).sections)
    ) {
        throw new CliError('INVALID_INPUT', `${file} doesn't contain template content`, [
            'It needs the projects, sections and tasks of `td template view <id> --content --json`',
        ])
    }
    return content as TemplateContent
}
