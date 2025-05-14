import * as vscode from 'vscode';
import { type Remote, type GitExtension, type Repository, type Change, Status } from './vendored/git';
import { Configuration } from './config';

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
		.replace(/^.+?@/, "")
		.replace(/(.*?):(.*?)$/, (_match, host, path) => `https://${host}/${path}`)
		.replace(/.git$/, "");
}

async function openCurrentLine() {
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

	const line = 1 + editor.selection.active.line;
	const filepath = vscode.workspace.asRelativePath(editor.document.uri);

	if (useCustomUrl) {
		const customUrl = getExtConfig().get<string>("customURL.url")!;
		vscode.env.openExternal(vscode.Uri.parse(replaceVariablesCustomUrl(customUrl, {
			username: (await getGitConfig(repository, "user.name")).replaceAll(" ", ""),
			ref: repository.state.HEAD?.name,
			line: String(line),
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
		}

		const remoteUrl = remote.fetchUrl ?? remote.pushUrl;
		if (remoteUrl === undefined) {
			vscode.window.showErrorMessage("No remote URL");
			return
		}

		const baseUri = vscode.Uri.parse(refineURL(remoteUrl));

		const isBitbucket = baseUri.authority.includes("bitbucket");

		const uri =
			isBitbucket
			? vscode.Uri.joinPath(
					baseUri,
					"src",
					repository.state.HEAD?.commit ?? "",
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
					"/blob", repository.state.HEAD?.name ?? "/",
					filepath,
				).with({
					fragment: `L${line}`
				});

		vscode.env.openExternal(uri);
	}
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('gitgps.openCurrentLine', openCurrentLine),
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
