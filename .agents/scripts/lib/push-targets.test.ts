import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findTargets } from './push-targets.ts'

// [kind, folder, sources] for each push, pull request and commit a command runs, from /w.
type Row = [string, string | null, string]

const read = (command: string): Row[] =>
    findTargets(command, '/w').map((target) => [target.kind, target.dir, target.sources.join(',')])

describe('findTargets', () => {
    it.each<[string, Row[]]>([
        ['git push', [['push', '/w', 'HEAD']]],
        ['cd ../other && git push origin main', [['push', '/other', 'main']]],
        [
            '(cd sub && git push) && git -C /x push',
            [
                ['push', '/w/sub', 'HEAD'],
                ['push', '/x', 'HEAD'],
            ],
        ],
        ['FOO=1 command git push 2>&1 | tail', [['push', '/w', 'HEAD']]],
        ['git push origin +feature:main :old tag v1', [['push', '/w', 'feature,refs/tags/v1']]],
        ['git push --all', [['push', '/w', '*']]],
        [
            'git push origin :; git push origin +:',
            [
                ['push', '/w', '*'],
                ['push', '/w', '*'],
            ],
        ],
        ['cd "$REPO"; (cd /tmp); git push', [['push', null, 'HEAD']]],
        ['cd - && git push', [['push', null, 'HEAD']]],
        ['cd ~/code && git push', [['push', join(homedir(), 'code'), 'HEAD']]],
        ['gh pr create --head me:feature --fill', [['pr', '/w', 'feature']]],
        [
            'git commit -m "fix: git push later" && git push',
            [
                ['commit', '/w', ''],
                ['push', '/w', 'HEAD'],
            ],
        ],
        // Wrappers, keywords and full paths still run git.
        ['if /usr/bin/git push; then echo ok; fi', [['push', '/w', 'HEAD']]],
        ['! timeout -k 5 60 nohup git push', [['push', '/w', 'HEAD']]],
        ['env -u FOO -C /x git push', [['push', '/x', 'HEAD']]],
        [
            'env -C/x git push; builtin git push',
            [
                ['push', '/x', 'HEAD'],
                ['push', '/w', 'HEAD'],
            ],
        ],
        ['git push --repo=origin backup', [['push', '/w', 'HEAD']]],
        ['command -p git push; command -v git push', [['push', '/w', 'HEAD']]],
        ['pushd sub && git push', [['push', '/w/sub', 'HEAD']]],
        ['git --git-dir=/r/.git push', [['push', null, 'HEAD']]],
        // A command split across lines, as agents write long ones.
        ['gh pr \\\n  create --fill', [['pr', '/w', 'HEAD']]],
        [
            'echo "$(cd /x && git push)" && git push',
            [
                ['push', '/x', 'HEAD'],
                ['push', '/w', 'HEAD'],
            ],
        ],
        // What git's settings pick can't be read from the command.
        ['git -c push.default=matching push', [['push', '/w', '*']]],
        ['git -c remote.origin.push=refs/heads/a push origin', [['push', '/w', '*']]],
        ['git -c remote.pushDefault=other push', [['push', '/w', '*']]],
        ['git --config-env=branch.a.pushRemote=R push', [['push', '/w', '*']]],
        ['git -c core.editor=vi push', [['push', '/w', 'HEAD']]],
        [
            'git push --mirror; git push --branches',
            [
                ['push', '/w', '*'],
                ['push', '/w', '*'],
            ],
        ],
        ["git push origin 'refs/heads/*:refs/heads/*'", [['push', '/w', 'refs/heads/*']]],
        [
            'gh -R o/r pr create --fill; gh pr new -H a; gh pr create --head=b',
            [
                ['pr', '/w', 'HEAD'],
                ['pr', '/w', 'a'],
                ['pr', '/w', 'b'],
            ],
        ],
        // Nothing that sends code: comments, quotes, here-documents, dry runs, deletions, tags.
        ['git push -fn # git push', []],
        ['echo "git push"; cat <<EOF\ngit push\nEOF', []],
        ["git commit -m 'git push' <<-'END'\n\tgit push\n\tEND", [['commit', '/w', '']]],
        ['git push --dry-run; git push -d origin old; git push --tags', []],
        ['gh pr view; gh pr list --state open; git pull', []],
    ])('reads %j', (command, expected) => {
        expect(read(command)).toEqual(expected)
    })

    it('takes the remote from an argument over --repo, as git does', () => {
        expect(findTargets('git push --repo=origin backup', '/w')[0]?.remote).toBe('backup')
        expect(findTargets('git push --repo origin', '/w')[0]?.remote).toBe('origin')
    })

    it('marks a push with no refspec as one git settings decide', () => {
        expect(findTargets('git push upstream', '/w')).toEqual([
            { kind: 'push', dir: '/w', sources: ['HEAD'], implicit: true, remote: 'upstream' },
        ])
        expect(findTargets('git push upstream feature', '/w')[0]?.implicit).toBeUndefined()
    })
})
