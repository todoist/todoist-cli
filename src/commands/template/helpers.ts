import type { Template } from '@todoist/sdk'
import chalk from 'chalk'

/**
 * Warns on stderr that a template command moved, so stdout (and `--json`) stays clean.
 * The old commands stay for one release as hidden aliases.
 */
export function warnDeprecated(oldCommand: string, replacement: string): void {
    console.error(
        chalk.yellow('Warning:'),
        `\`${oldCommand}\` is deprecated and will be removed in a future release. Use \`${replacement}\` instead.`,
    )
}

export function printSavedTemplate(template: Template, label = 'Saved template'): void {
    console.log(`${label}: ${template.name}`)
    console.log(chalk.dim(`ID: ${template.id}`))
    console.log(
        chalk.dim(
            template.workspaceId
                ? `Workspace template${template.sharedWithWorkspaceMembers ? ', shared with members' : ''}`
                : 'Personal template',
        ),
    )
}

/** Where a template comes from, as the CLI names it: gallery, personal or workspace. */
export function describeTemplateSource(template: Template): string {
    if (template.templateSource === 'todoist') {
        return 'gallery'
    }
    if (template.workspaceId) {
        return template.sharedWithWorkspaceMembers ? 'workspace, shared with members' : 'workspace'
    }
    return 'personal'
}
