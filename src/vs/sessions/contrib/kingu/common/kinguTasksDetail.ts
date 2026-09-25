/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/*
 * One task's detail page and starting a workspace from it, ported from the
 * ADE's item dialogs (`task-page/github/ItemDialog.tsx`, `gitlab/ItemDialog.tsx`,
 * `jira/IssueDrawer.tsx`, `linear/IssueDrawer.tsx`) and `lib/new-workspace.ts`.
 * Every provider's answer is read into one shape, so the page draws one way.
 */

import { localize } from '../../../../nls.js';
import { IKinguGitHubWorkItem, IKinguRepo } from './kinguTasksGitHub.js';
import { formatGitLabReference, IKinguGitLabWorkItem } from './kinguTasksGitLab.js';
import { IKinguJiraIssue } from './kinguTasksJira.js';
import { IKinguLinearIssue } from './kinguTasksLinear.js';

/** A row a list offers to open or start work from, with what the list already knows of it. */
export type IKinguTaskRef =
	| { readonly provider: 'github'; readonly repo: IKinguRepo; readonly item: IKinguGitHubWorkItem }
	| { readonly provider: 'gitlab'; readonly repo: IKinguRepo; readonly item: IKinguGitLabWorkItem }
	| { readonly provider: 'jira'; readonly issue: IKinguJiraIssue }
	| { readonly provider: 'linear'; readonly issue: IKinguLinearIssue };

/** What a list asks of the page around it. */
export interface IKinguTaskActions {
	openDetail(ref: IKinguTaskRef): void;
	startWorkspace(ref: IKinguTaskRef): void;
}

export interface IKinguTaskComment {
	readonly id: string;
	readonly author: string;
	readonly avatarUrl?: string;
	readonly body: string;
	readonly createdAt: string;
	readonly url?: string;
	/** The file an inline review comment is on. */
	readonly path?: string;
}

export interface IKinguTaskFact {
	readonly label: string;
	readonly value: string;
}

/** A task as the detail page draws it. */
export interface IKinguTaskDetail {
	/** Markdown, or plain text where the provider has no markdown. */
	readonly body: string;
	readonly comments: readonly IKinguTaskComment[];
	readonly facts: readonly IKinguTaskFact[];
}

/** One `kinguOrca` invoke. */
export interface IKinguTaskRequest {
	readonly channel: string;
	readonly args: Record<string, unknown>;
}

/** The ADE's `DEFAULT_ISSUE_COMMAND_TEMPLATE`. */
const DEFAULT_ISSUE_COMMAND = 'Complete {0}';

export function getTaskReference(ref: IKinguTaskRef): string {
	switch (ref.provider) {
		case 'github': return `#${ref.item.number}`;
		case 'gitlab': return formatGitLabReference(ref.item);
		case 'jira': return ref.issue.key;
		case 'linear': return ref.issue.identifier;
	}
}

export function getTaskTitle(ref: IKinguTaskRef): string {
	return ref.provider === 'github' || ref.provider === 'gitlab' ? ref.item.title : ref.issue.title;
}

export function getTaskUrl(ref: IKinguTaskRef): string {
	return ref.provider === 'github' || ref.provider === 'gitlab' ? ref.item.url : ref.issue.url;
}

/** The repository a task belongs to; Jira and Linear issues belong to none. */
export function getTaskRepo(ref: IKinguTaskRef): IKinguRepo | undefined {
	return ref.provider === 'github' || ref.provider === 'gitlab' ? ref.repo : undefined;
}

/**
 * The prompt the new-workspace composer opens with. As in the ADE, GitHub and
 * GitLab items run the issue command (`Complete <url>`); Jira and Linear
 * issues are linked context the reader writes their own prompt above. The
 * title and body are never pasted in: the agent reads the link.
 */
export function getStartWorkspacePrompt(ref: IKinguTaskRef): string {
	switch (ref.provider) {
		case 'github':
		case 'gitlab':
			return DEFAULT_ISSUE_COMMAND.replace('{0}', ref.item.url);
		case 'jira':
			return `Linked work items:\n- ${ref.issue.url}`;
		case 'linear':
			return `Linked Linear issue: ${ref.issue.identifier}\n${ref.issue.url}`;
	}
}

/** The calls that load a task's detail: one for the repo hosts, the issue and its comments for Jira and Linear. */
export function getTaskDetailRequests(ref: IKinguTaskRef): readonly IKinguTaskRequest[] {
	switch (ref.provider) {
		case 'github':
			return [{ channel: 'gh:workItemDetails', args: { repoPath: ref.repo.path, repoId: ref.repo.id, number: ref.item.number, type: ref.item.type } }];
		case 'gitlab':
			return [{ channel: 'gitlab:workItemDetails', args: { repoPath: ref.repo.path, repoId: ref.repo.id, iid: ref.item.number, type: ref.item.type } }];
		case 'jira': {
			const site = ref.issue.siteId ? { siteId: ref.issue.siteId } : {};
			return [
				{ channel: 'jira:getIssue', args: { key: ref.issue.key, ...site } },
				{ channel: 'jira:issueComments', args: { key: ref.issue.key, ...site } },
			];
		}
		case 'linear': {
			const workspace = ref.issue.workspaceId ? { workspaceId: ref.issue.workspaceId } : {};
			return [
				{ channel: 'linear:getIssue', args: { id: ref.issue.id, ...workspace } },
				{ channel: 'linear:issueComments', args: { issueId: ref.issue.id, ...workspace } },
			];
		}
	}
}

/** The call that posts a comment on a task. */
export function getAddCommentRequest(ref: IKinguTaskRef, body: string): IKinguTaskRequest {
	switch (ref.provider) {
		case 'github':
			return { channel: 'gh:addIssueComment', args: { repoPath: ref.repo.path, repoId: ref.repo.id, number: ref.item.number, type: ref.item.type, body } };
		case 'gitlab':
			return ref.item.type === 'mr'
				? { channel: 'gitlab:addMRComment', args: { repoPath: ref.repo.path, repoId: ref.repo.id, iid: ref.item.number, body } }
				: { channel: 'gitlab:addIssueComment', args: { repoPath: ref.repo.path, repoId: ref.repo.id, number: ref.item.number, body } };
		case 'jira':
			return { channel: 'jira:addIssueComment', args: { key: ref.issue.key, body, ...(ref.issue.siteId ? { siteId: ref.issue.siteId } : {}) } };
		case 'linear':
			return { channel: 'linear:addIssueComment', args: { issueId: ref.issue.id, body, ...(ref.issue.workspaceId ? { workspaceId: ref.issue.workspaceId } : {}) } };
	}
}

/** `PRComment` and `MRComment`. */
interface IRepoHostComment {
	readonly id: number | string;
	readonly author?: string;
	readonly authorAvatarUrl?: string;
	readonly body?: string;
	readonly createdAt: string;
	readonly url?: string;
	readonly path?: string;
}

/** A person as Jira and Linear send one. */
interface IProviderUser {
	readonly displayName?: string;
	readonly avatarUrl?: string;
}

/** `GitHubWorkItemDetails` and `GitLabWorkItemDetails`, the parts the page reads. */
interface IRepoHostDetails {
	readonly body?: string;
	readonly comments?: readonly IRepoHostComment[];
	readonly assignees?: readonly string[];
	readonly files?: readonly unknown[];
	readonly reviewers?: readonly { readonly username?: string; readonly login?: string }[];
	readonly item?: { readonly author?: string | null; readonly baseRefName?: string; readonly branchName?: string; readonly sourceBranch?: string; readonly targetBranch?: string };
}

/** The ADE's `JiraIssue`, the parts the page reads. */
interface IJiraIssueDetails {
	readonly description?: string;
	readonly issueType?: { readonly name?: string };
	readonly reporter?: IProviderUser;
	readonly assignee?: IProviderUser;
	readonly priority?: { readonly name?: string };
	readonly project?: { readonly key?: string; readonly name?: string };
	readonly createdAt?: string;
}

/** The ADE's `LinearIssue`, the parts the page reads. */
interface ILinearIssueDetails {
	readonly description?: string;
	readonly branchName?: string;
	readonly assignee?: IProviderUser;
	readonly team?: { readonly name?: string; readonly key?: string };
	readonly project?: { readonly name?: string } | null;
}

interface IProviderComment {
	readonly id: string;
	readonly body?: string;
	readonly createdAt: string;
	readonly user?: IProviderUser;
}

function byCreated(a: IKinguTaskComment, b: IKinguTaskComment): number {
	return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

function unknownAuthor(): string {
	return localize('kingu.tasks.detail.unknownAuthor', "Unknown");
}

function repoHostComments(comments: readonly IRepoHostComment[] | undefined): IKinguTaskComment[] {
	return (comments ?? []).map(comment => ({
		id: String(comment.id),
		author: comment.author || unknownAuthor(),
		avatarUrl: comment.authorAvatarUrl || undefined,
		body: comment.body ?? '',
		createdAt: comment.createdAt,
		url: comment.url || undefined,
		path: comment.path || undefined,
	})).sort(byCreated);
}

function providerComments(comments: readonly IProviderComment[] | undefined): IKinguTaskComment[] {
	return (comments ?? []).map(comment => ({
		id: comment.id,
		author: comment.user?.displayName || unknownAuthor(),
		avatarUrl: comment.user?.avatarUrl || undefined,
		body: comment.body ?? '',
		createdAt: comment.createdAt,
	})).sort(byCreated);
}

function fact(facts: IKinguTaskFact[], label: string, value: string | undefined | null): void {
	if (value) {
		facts.push({ label, value });
	}
}

/**
 * Reads what the detail calls answered into the page's shape. `answers` are in
 * the order of `getTaskDetailRequests`; a Jira or Linear comment list that
 * failed is `undefined`, and the issue still shows.
 */
export function readTaskDetail(ref: IKinguTaskRef, answers: readonly unknown[]): IKinguTaskDetail {
	const facts: IKinguTaskFact[] = [];
	switch (ref.provider) {
		case 'github':
		case 'gitlab': {
			const details = (answers[0] ?? {}) as IRepoHostDetails;
			fact(facts, localize('kingu.tasks.detail.project', "Project"), ref.repo.displayName);
			fact(facts, localize('kingu.tasks.detail.author', "Author"), details.item?.author ?? ref.item.author);
			const assignees = details.assignees ?? (ref.provider === 'github' ? ref.item.assignees?.map(person => person.login) : undefined);
			fact(facts, localize('kingu.tasks.detail.assignees', "Assignees"), assignees?.join(', '));
			const reviewers = details.reviewers?.map(person => person.username ?? person.login).filter((name): name is string => !!name);
			fact(facts, localize('kingu.tasks.detail.reviewers', "Reviewers"), reviewers?.join(', '));
			if (details.files) {
				fact(facts, localize('kingu.tasks.detail.files', "Files changed"), String(details.files.length));
			}
			return { body: details.body ?? '', comments: repoHostComments(details.comments), facts };
		}
		case 'jira': {
			const issue = (answers[0] ?? {}) as IJiraIssueDetails;
			fact(facts, localize('kingu.tasks.detail.type', "Type"), issue.issueType?.name);
			fact(facts, localize('kingu.tasks.detail.project', "Project"), issue.project?.name ?? issue.project?.key ?? ref.issue.project.key);
			fact(facts, localize('kingu.tasks.detail.priority', "Priority"), issue.priority?.name ?? ref.issue.priority?.name);
			fact(facts, localize('kingu.tasks.detail.assignee', "Assignee"), (issue.assignee ?? ref.issue.assignee)?.displayName ?? localize('kingu.tasks.unassigned', "Unassigned"));
			fact(facts, localize('kingu.tasks.detail.reporter', "Reporter"), issue.reporter?.displayName);
			return { body: issue.description ?? '', comments: providerComments(answers[1] as readonly IProviderComment[] | undefined), facts };
		}
		case 'linear': {
			const issue = (answers[0] ?? {}) as ILinearIssueDetails;
			fact(facts, localize('kingu.tasks.detail.team', "Team"), issue.team?.name ?? ref.issue.team.name);
			fact(facts, localize('kingu.tasks.detail.linearProject', "Project"), issue.project?.name);
			fact(facts, localize('kingu.tasks.detail.assignee', "Assignee"), (issue.assignee ?? ref.issue.assignee)?.displayName ?? localize('kingu.tasks.unassigned', "Unassigned"));
			fact(facts, localize('kingu.tasks.detail.branch', "Branch"), issue.branchName);
			return { body: issue.description ?? '', comments: providerComments(answers[1] as readonly IProviderComment[] | undefined), facts };
		}
	}
}

/**
 * Reads a comment call's answer. The repo hosts send the posted comment back;
 * Jira and Linear send only its id, so the page shows the text it sent.
 */
export function readAddCommentResult(result: unknown, body: string, now: Date): { readonly ok: true; readonly comment: IKinguTaskComment } | { readonly ok: false; readonly error: string } {
	const answer = result as { ok?: boolean; error?: string; id?: string; comment?: IRepoHostComment } | undefined;
	if (!answer?.ok) {
		return { ok: false, error: answer?.error || localize('kingu.tasks.detail.commentFailed', "The comment could not be posted.") };
	}
	if (answer.comment) {
		return { ok: true, comment: repoHostComments([answer.comment])[0] };
	}
	return { ok: true, comment: { id: answer.id ?? `local-${now.getTime()}`, author: localize('kingu.tasks.detail.you', "You"), body, createdAt: now.toISOString() } };
}
