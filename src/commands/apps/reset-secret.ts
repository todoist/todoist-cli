import { getErrorMessage } from '@todoist/cli-core'
import chalk from 'chalk'
import { getApi } from '../../lib/api/core.js'
import { CliError } from '../../lib/errors.js'
import { isQuiet } from '../../lib/global-args.js'
import { printDryRun, processJsonItem } from '../../lib/output.js'
import { resolveAppRef } from '../../lib/refs.js'

export interface ResetAppSecretOptions {
    yes?: boolean
    dryRun?: boolean
    json?: boolean
}

const OLD_SECRET_WARNING =
    'The current client secret stops working immediately: every service using it breaks until it is updated with the new one.'

export async function resetAppSecret(ref: string, options: ResetAppSecretOptions): Promise<void> {
    // Under --json there is no preview to print, so a missing --yes is an
    // error rather than a silent no-op.
    if (options.json && !options.yes && !options.dryRun) {
        throw new CliError(
            'CONFIRMATION_REQUIRED',
            'Pass --yes to execute td apps reset-secret, or --dry-run to preview it.',
            [OLD_SECRET_WARNING],
        )
    }

    const api = await getApi()
    const app = await resolveAppRef(api, ref)

    if (options.dryRun) {
        printDryRun('reset client secret', {
            App: app.displayName,
            ID: app.id,
            Warning: OLD_SECRET_WARNING,
        })
        return
    }

    if (!options.yes) {
        console.log(`Would reset the client secret for: ${app.displayName} (id:${app.id})`)
        console.log(OLD_SECRET_WARNING)
        console.log('Use --yes to confirm.')
        return
    }

    const updatedApp = await api.resetAppClientSecret(app.id)

    // The reset has already happened, so a failure here must not read as if
    // nothing changed: running the command again would rotate the secret a
    // second time.
    let clientSecret: string
    try {
        ;({ clientSecret } = await api.getAppSecrets(app.id))
    } catch (error) {
        throw new CliError(
            'PARTIAL_FAILURE',
            `The client secret for ${app.displayName} (id:${app.id}) was reset, but reading the new secret failed: ${getErrorMessage(error)}`,
            [
                'The old secret no longer works. Do not reset it again.',
                `Read the new secret with: td apps view id:${app.id} --include-secrets`,
            ],
        )
    }

    if (options.json) {
        console.log(
            JSON.stringify({ ...processJsonItem(updatedApp, 'app'), clientSecret }, null, 2),
        )
        return
    }

    if (isQuiet()) {
        console.log(clientSecret)
        return
    }

    console.log(`Reset the client secret for: ${app.displayName} (id:${app.id})`)
    console.log('')
    console.log(`  Client ID:          ${updatedApp.clientId}`)
    console.log(`  Client secret:      ${clientSecret}`)
    console.log('')
    console.log(
        chalk.yellow(
            'The previous secret no longer works. Update every service that uses it with the new one.',
        ),
    )
}
