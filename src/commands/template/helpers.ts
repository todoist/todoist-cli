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
