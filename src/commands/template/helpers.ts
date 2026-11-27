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

export function printSavedTemplate(template: Template): void {
    console.log(`Saved template: ${template.name}`)
    console.log(chalk.dim(`ID: ${template.id}`))
    console.log(
        chalk.dim(
            template.workspaceId
                ? `Workspace template${template.sharedWithWorkspaceMembers ? ', shared with members' : ''}`
                : 'Personal template',
        ),
    )
}
