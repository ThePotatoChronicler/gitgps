import * as vscode from 'vscode';
import { type Remote, type GitExtension, type Repository, type Change, Status } from './vendored/git';
import { Configuration } from './config';
import { oneLine } from 'common-tags';
import { assertUnreachable } from './util';

function getExtConfig(scope?: Parameters<typeof vscode.workspace.getConfiguration>[1]) {
	return vscode.workspace.getConfiguration("gitgps", scope);
}

function getRemote(repository: Repository): Remote | null {
	const remotes = repository.state.remotes;

	const headRemote = repository.state.HEAD?.upstream?.remote;
	if (headRemote !== undefined) {
		const remote = remotes.find(r => r.name === headRemote);
		if (remote !== undefined)
			return remote;
	}

	const prefferedRemoteName = getExtConfig().get<Configuration["prefferedRemote"]>("prefferedRemote")!;

	const prefferedRemote = remotes.find(r => r.name === prefferedRemoteName);
	if (prefferedRemote !== undefined)
		return prefferedRemote;

	if (remotes.length > 0)
		return remotes[0];

	return null;
}

function replaceVariablesCustomUrl(customUrl: string, variables: { [v: string]: string | undefined }): string {
	return customUrl.replace(/(?<!\\){([^{}]*?)(?<!\\)}/g, (_match, varKey) => variables[varKey] ?? "")
}

async function getGitConfig(repository: Repository, key: string): Promise<string> {
	const localConfig = await repository.getConfig(key)
	if (localConfig.length > 0)
		return localConfig;

	return await repository.getGlobalConfig(key);
}

function getFileChanges(repository: Repository, uri: vscode.Uri): Change[] {
	return repository.state.workingTreeChanges.filter(c => c.uri.toString() == uri.toString());
}

function refineURL(url: string): string {
	return url
		// WARN: This breaks if by any chance the URL contains a port,
		//       but I've never seen any git with a port
		.replace(/^(https?:\/\/)?(?:(?:.+?)@)?(?:([^:]*?)|(.*?):(.*?))(?:.git)?$/,
			(_match, schema, maybe_uri, maybe_domain, maybe_path) => {
				console.log({ schema, maybe_uri, maybe_domain, maybe_path });
				return (
					schema ? schema : "https://"
				)
				+ (
					maybe_uri
					? maybe_uri
					: `${maybe_domain}/${maybe_path}`
				)
			})
}

function formatLine(
	{
		lineStart, lineEnd, format = "github",
	}
		: { lineStart: number, lineEnd?: number, format?: "github" | "bitbucket" }
): string {
	if (format == "github") {
		if (lineEnd === undefined || lineStart === lineEnd) {
			return `L${lineStart}`
		} else {
			return `L${lineStart}-L${lineEnd}`;
		}
	} else if (format == "bitbucket") {
		if (lineEnd === undefined || lineStart === lineEnd) {
			return `${lineStart}`
		} else {
			return `${lineStart}:${lineEnd}`;
		}
	} else {
		assertUnreachable(format);
	}
}

async function openCurrentLine(
	{ permalink = false, }
		: {
			permalink?: boolean
		} = {}
	) {
	const git = vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports.getAPI(1);
	if (git === undefined) {
		vscode.window.showErrorMessage("Cannot get extension vscode.git")
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (editor === undefined) {
		vscode.window.showErrorMessage("No active text editor")
		return;
	}

	const repository = git.getRepository(editor.document.uri);

	if (repository === null) {
		vscode.window.showErrorMessage("Currently opened file is not in a git repository")
		return;
	}

	const useCustomUrl = getExtConfig().get<boolean>("customURL.enabled")!;

	const lineStart = 1 + editor.selection.start.line;
	const lineEnd = 1 + editor.selection.end.line;
	const filepath = vscode.workspace.asRelativePath(editor.document.uri);

	if (useCustomUrl) {
		const customUrl = getExtConfig().get<string>("customURL.url")!;
		vscode.env.openExternal(vscode.Uri.parse(replaceVariablesCustomUrl(customUrl, {
			username: (await getGitConfig(repository, "user.name")).replaceAll(" ", ""),
			ref: permalink ? repository.state.HEAD?.commit : repository.state.HEAD?.name,
			lineGithub: formatLine({ lineStart, lineEnd, format: "github" }),
			lineBitbucket: formatLine({ lineStart, lineEnd, format: "bitbucket" }),
			filepath,
			folderName: vscode.workspace.getWorkspaceFolder(editor.document.uri)?.name,
		})));
	} else {
		const remote = getRemote(repository);
		if (remote === null) {
			vscode.window.showErrorMessage("Current git repository has no remotes")
			return;
		}

		const changes = getFileChanges(repository, editor.document.uri);

		if (changes.length > 0) {
			const change = changes[0];
			if (change.status === Status.UNTRACKED) {
				vscode.window.showErrorMessage("Current file is untracked, and has no remote URL")
				return;
			}
			if ([Status.MODIFIED, Status.BOTH_MODIFIED].includes(change.status)) {
				vscode.window.showWarningMessage(oneLine`
					Current file is modified, line number will most likely be wrong
					(we do not support partially modified files)
				`) // TODO: Maybe add support?
			}
		}

		const remoteUrl = remote.fetchUrl ?? remote.pushUrl;
		if (remoteUrl === undefined) {
			vscode.window.showErrorMessage("No remote URL");
			return
		}

		const baseUri = vscode.Uri.parse(refineURL(remoteUrl));

		const isBitbucket = baseUri.authority.includes("bitbucket");

		const line = formatLine({ lineStart, lineEnd, format: isBitbucket ? "bitbucket" : "github" });

		const ref =
			permalink
			? repository.state.HEAD?.commit
			: (repository.state.HEAD?.name ?? repository.state.HEAD?.commit);
		
		const uri =
			isBitbucket
			? vscode.Uri.joinPath(
					baseUri,
					"src",
					ref ?? "",
					filepath,
				).with({
					query:
						repository.state.HEAD?.name
						? `at=${repository.state.HEAD.name}`
						: "",
					fragment: `lines-${line}`,
				})
			: vscode.Uri.joinPath(
					baseUri,
					"/blob", ref ?? "",
					filepath,
				).with({
					fragment: `${line}`,
				});

		console.log({ uri, line, baseUri, remoteUrl })

		vscode.env.openExternal(uri);
	}
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('gitgps.openCurrentLine', openCurrentLine),
		vscode.commands.registerCommand(
			'gitgps.openCurrentLinePermalink',
			() => openCurrentLine({ permalink: true })
		),
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
