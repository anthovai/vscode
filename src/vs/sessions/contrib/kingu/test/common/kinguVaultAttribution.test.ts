/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ancestorDirectories,
	basename,
	KinguProjectKind,
	projectFor,
	readWorktreeRepository,
	toUriPath,
	unattributedProject,
} from '../../common/kinguVaultAttribution.js';

suite('Kingu vault attribution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('what a working directory belongs to', () => {

		test('a checkout is the repository', () => {
			const project = projectFor({
				workingDirectory: '/home/dev/app/src/server',
				hostLabel: undefined,
				repositoryRoot: '/home/dev/app',
				worktreeOf: undefined,
			});
			assert.strictEqual(project.kind, KinguProjectKind.Repository);
			assert.strictEqual(project.label, 'app');
			assert.strictEqual(project.path, '/home/dev/app');
		});

		test('a linked worktree is named after both, because its own name is a branch', () => {
			const project = projectFor({
				workingDirectory: '/home/dev/worktrees/feature-x',
				hostLabel: undefined,
				repositoryRoot: '/home/dev/worktrees/feature-x',
				worktreeOf: '/home/dev/app',
			});
			assert.strictEqual(project.kind, KinguProjectKind.Worktree);
			assert.strictEqual(project.label, 'app · feature-x');
			assert.strictEqual(project.repositoryPath, '/home/dev/app');
		});

		test('a directory outside any repository attributes to itself', () => {
			// Taking its parent would put two unrelated projects in one row.
			const project = projectFor({
				workingDirectory: '/tmp/scratch',
				hostLabel: undefined,
				repositoryRoot: undefined,
				worktreeOf: undefined,
			});
			assert.strictEqual(project.kind, KinguProjectKind.Directory);
			assert.strictEqual(project.label, 'scratch');
		});

		test('the same path on two machines is two projects', () => {
			const here = projectFor({ workingDirectory: '/home/dev/app', hostLabel: undefined, repositoryRoot: '/home/dev/app', worktreeOf: undefined });
			const there = projectFor({ workingDirectory: '/home/dev/app', hostLabel: 'build-box', repositoryRoot: '/home/dev/app', worktreeOf: undefined });
			assert.notStrictEqual(here.id, there.id);
		});

		test('a session that recorded no directory says so rather than showing blank', () => {
			const project = unattributedProject(undefined);
			assert.strictEqual(project.kind, KinguProjectKind.Unattributed);
			assert.ok(project.label.trim());
			assert.strictEqual(project.path, undefined);
		});
	});

	suite('reading a worktree pointer', () => {

		test('takes the repository from above the .git it points into', () => {
			assert.strictEqual(
				readWorktreeRepository('gitdir: /home/dev/app/.git/worktrees/feature-x\n'),
				'/home/dev/app');
		});

		test('reads a Windows pointer, which git writes with backslashes', () => {
			assert.strictEqual(
				readWorktreeRepository('gitdir: C:\\Users\\me\\app\\.git\\worktrees\\feature-x'),
				'C:/Users/me/app');
		});

		test('a pointer that is not into a worktree directory is not a worktree', () => {
			// A submodule's `.git` is also a gitdir pointer, and it is not this.
			assert.strictEqual(readWorktreeRepository('gitdir: /home/dev/app/.git/modules/vendor'), undefined);
		});

		test('anything that is not a pointer at all reads as none', () => {
			assert.strictEqual(readWorktreeRepository(''), undefined);
			assert.strictEqual(readWorktreeRepository('ref: refs/heads/main'), undefined);
		});
	});

	suite('walking up for a repository', () => {

		test('nearest first, so the innermost repository wins', () => {
			assert.deepStrictEqual(ancestorDirectories('/a/b/c', 10), ['/a/b/c', '/a/b', '/a']);
		});

		test('stops at the posix root rather than walking into an empty path', () => {
			assert.deepStrictEqual(ancestorDirectories('/a', 10), ['/a']);
		});

		test('stops at a Windows drive root', () => {
			assert.deepStrictEqual(ancestorDirectories('C:/Users/me', 10), ['C:/Users/me', 'C:/Users']);
		});

		test('is bounded, so a deep path does not walk the whole tree', () => {
			assert.strictEqual(ancestorDirectories('/a/b/c/d/e/f', 3).length, 3);
		});

		test('a trailing separator is not a level of its own', () => {
			assert.deepStrictEqual(ancestorDirectories('/a/b/', 10), ['/a/b', '/a']);
		});
	});

	suite('turning a host path into a URI path', () => {

		test('a Windows path gains the leading slash a URI with an authority requires', () => {
			// Without this, building a sibling resource on a remote Windows host threw
			// `UriError` — and it threw for every session, taking the report with it.
			assert.strictEqual(toUriPath('C:\\Users\\me\\app'), '/C:/Users/me/app');
		});

		test('a posix path is already one and is left alone', () => {
			assert.strictEqual(toUriPath('/home/dev/app'), '/home/dev/app');
		});

		test('a UNC-shaped path keeps its shape rather than gaining a third slash', () => {
			assert.strictEqual(toUriPath('\\\\wsl.localhost\\Ubuntu\\home'), '//wsl.localhost/Ubuntu/home');
		});
	});

	test('basename reads either separator, because hosts differ', () => {
		assert.strictEqual(basename('/home/dev/app'), 'app');
		assert.strictEqual(basename('C:\\Users\\me\\app'), 'app');
		assert.strictEqual(basename('/home/dev/app/'), 'app');
	});
});
