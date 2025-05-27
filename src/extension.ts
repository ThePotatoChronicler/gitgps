import * as vscode from 'vscode';
import { Configuration } from './config';
import { oneLine } from 'common-tags';
import { assertUnreachable } from './util';
import simpleGit, { RemoteWithRefs, SimpleGit } from 'simple-git';
import { dirname, relative } from 'node:path';
import gitUrlParse from 'git-url-parse';

function getExtConfig(scope?: Parameters<typeof vscode.workspace.getConfiguration>[1]) {
	return vscode.workspace.getConfiguration("gitgps", scope);
}

function stripBranchFromRemote(remote: string): string {
	return remote.match(/(.+?)\//)?.[1] ?? remote;
}

async function getRemote(git: SimpleGit): Promise<RemoteWithRefs | null> {
	const remotes = await git.getRemotes(true);

	try {
		const headRemote = stripBranchFromRemote(await git.revparse(["--abbrev-ref", "@{upstream}"]));
		if (headRemote.length > 0) {
			const remote = remotes.find(r => r.name === headRemote);
			if (remote !== undefined) {
				return remote;
			}
		}
	} catch {}

	const prefferedRemoteName = getExtConfig().get<Configuration["prefferedRemote"]>("prefferedRemote")!;

	const prefferedRemote = remotes.find(r => r.name === prefferedRemoteName);
	if (prefferedRemote !== undefined) {
		return prefferedRemote;
	}

	if (remotes.length > 0) {
		return remotes[0];
	}

	return null;
}

function replaceVariablesCustomUrl(customUrl: string, variables: { [v: string]: string | undefined }): string {
	return customUrl.replace(/(?<!\\){([^{}]*?)(?<!\\)}/g, (_match, varKey) => variables[varKey] ?? "");
}

async function getGitConfig(git: SimpleGit, key: string): Promise<string | null> {
	return (await git.getConfig(key)).value;
}

function refineURL(url: string): string {
	return gitUrlParse(url).toString("https").replace(/\.git$/, "");
}

function formatLine(
	{
		lineStart, lineEnd, format = "github",
	}
		: { lineStart: number, lineEnd?: number, format?: "github" | "bitbucket" }
): string {
	if (format === "github") {
		if (lineEnd === undefined || lineStart === lineEnd) {
			return `L${lineStart}`;
		} else {
			return `L${lineStart}-L${lineEnd}`;
		}
	} else if (format === "bitbucket") {
		if (lineEnd === undefined || lineStart === lineEnd) {
			return `${lineStart}`;
		} else {
			return `${lineStart}:${lineEnd}`;
		}
	} else {
		assertUnreachable(format);
	}
}

async function getCurrentLine(
	{ permalink = false, }
		: {
			permalink?: boolean
		} = {}
	): Promise<undefined | vscode.Uri> {
	const editor = vscode.window.activeTextEditor;
	if (editor === undefined) {
		vscode.window.showErrorMessage("No active text editor");
		return;
	}

	const git = simpleGit({
		baseDir: dirname(editor.document.fileName),
	});

	if (!await git.checkIsRepo()) {
		vscode.window.showErrorMessage("Currently opened file is not in a git repository");
		return;
	}

	const toplevel = await git.revparse("--show-toplevel");

	const useCustomUrl = getExtConfig().get<boolean>("customURL.enabled")!;

	const lineStart = 1 + editor.selection.start.line;
	const lineEnd = 1 + editor.selection.end.line;
	const filepath = relative(toplevel, editor.document.fileName);

	const headCommit = await git.revparse("HEAD");
	const headSymbolic = await git.revparse(["--abbrev-ref", "HEAD"]);

	const ref = permalink ? headCommit : headSymbolic;

	if (useCustomUrl) {
		const customUrl = getExtConfig().get<string>("customURL.url")!;
		return vscode.Uri.parse(replaceVariablesCustomUrl(customUrl, {
			username: (await getGitConfig(git, "user.name") ?? "").replaceAll(" ", ""),
			ref,
			lineGithub: formatLine({ lineStart, lineEnd, format: "github" }),
			lineBitbucket: formatLine({ lineStart, lineEnd, format: "bitbucket" }),
			filepath,
			folderName: vscode.workspace.getWorkspaceFolder(editor.document.uri)?.name,
		}));
	} else {
		const remote = await getRemote(git);
		if (remote === null) {
			vscode.window.showErrorMessage("Current git repository has no remotes");
			return;
		}

		const changes = await git.status();

		if (changes.ahead > 0) {
			vscode.window.showWarningMessage("Git HEAD is ahead of upstream, line numbers will most likely be wrong");
		}

		if (changes.behind > 0) {
			vscode.window.showWarningMessage("Git HEAD is behind upstream, line numbers will most likely be wrong");
		}

		if (changes.not_added.includes(filepath) || changes.created.includes(filepath)) {
			vscode.window.showErrorMessage("Current file is untracked, and has no remote URL");
			return;
		}

		if (changes.modified.includes(filepath)) {
			vscode.window.showWarningMessage(oneLine`
				Current file is modified, line numbers will most likely be wrong
				(we do not support partially modified files)
			`); // TODO: Maybe add support?
		}

		const remoteUrl = remote.refs.fetch ?? remote.refs.push;
		if (remoteUrl === undefined) {
			vscode.window.showErrorMessage("No remote URL");
			return;
		}

		const baseUri = vscode.Uri.parse(refineURL(remoteUrl));

		const isBitbucket = baseUri.authority.includes("bitbucket");

		const line = formatLine({ lineStart, lineEnd, format: isBitbucket ? "bitbucket" : "github" });

		const uri =
			isBitbucket
			? vscode.Uri.joinPath(
					baseUri,
					"src",
					headCommit ?? "",
					filepath,
				).with({
					query: `at=${headSymbolic}`,
					fragment: `lines-${line}`,
				})
			: vscode.Uri.joinPath(
					baseUri,
					"/blob", ref ?? "",
					filepath,
				).with({
					fragment: `${line}`,
				});

		return uri;
	}
}

async function showLineDebugInfo() {
	const editor = vscode.window.activeTextEditor;
	if (editor === undefined) {
		vscode.window.showErrorMessage("No active text editor");
		return;
	}

	const git = simpleGit({
		baseDir: dirname(editor.document.fileName),
	});

	if (!await git.checkIsRepo()) {
		vscode.window.showErrorMessage("Currently opened file is not in a git repository");
		return;
	}

	const toplevel = await git.revparse("--show-toplevel");

	const lineStart = 1 + editor.selection.start.line;
	const lineEnd = 1 + editor.selection.end.line;
	const filepath = relative(toplevel, editor.document.fileName);

	const headCommit = await git.revparse("HEAD");
	const headSymbolic = await git.revparse(["--abbrev-ref", "HEAD"]);

  // If we're not on a branch, becomes perma-link
  // TODO: Handle tags (maybe by picking the only one pointing at HEAD)
  // Also maybe breaks with a branch and/or tag named HEAD?
	const ref = headSymbolic === "HEAD" ? headCommit : headSymbolic;

	const customUrlVariables = {
		username: (await getGitConfig(git, "user.name") ?? "").replaceAll(" ", ""),
		ref,
		lineGithub: formatLine({ lineStart, lineEnd, format: "github" }),
		lineBitbucket: formatLine({ lineStart, lineEnd, format: "bitbucket" }),
		filepath,
		folderName: vscode.workspace.getWorkspaceFolder(editor.document.uri)?.name,
	};

	const customUrl = getExtConfig().get<string>("customURL.url")!;
	const generatedCustomUrl = vscode.Uri.parse(replaceVariablesCustomUrl(customUrl, customUrlVariables));

	const remote = await getRemote(git);
	if (remote === null) {
		vscode.window.showErrorMessage("Current git repository has no remotes");
		return;
	}

	const changes = await git.status();

	if (changes.ahead > 0) {
		vscode.window.showWarningMessage("Git HEAD is ahead of upstream, line numbers will most likely be wrong");
	}

	if (changes.behind > 0) {
		vscode.window.showWarningMessage("Git HEAD is behind upstream, line numbers will most likely be wrong");
	}

	if (changes.not_added.includes(filepath) || changes.created.includes(filepath)) {
		vscode.window.showErrorMessage("Current file is untracked, and has no remote URL");
		return;
	}

	if (changes.modified.includes(filepath)) {
		vscode.window.showWarningMessage(oneLine`
			Current file is modified, line numbers will most likely be wrong
			(we do not support partially modified files)
		`); // TODO: Maybe add support?
	}

	const remoteUrl = remote.refs.fetch ?? remote.refs.push;
	if (remoteUrl === undefined) {
		vscode.window.showErrorMessage("No remote URL");
		return;
	}

	const baseUri = vscode.Uri.parse(refineURL(remoteUrl));

	const isBitbucket = baseUri.authority.includes("bitbucket");

	const line = formatLine({ lineStart, lineEnd, format: isBitbucket ? "bitbucket" : "github" });

	const uri =
		isBitbucket
		? vscode.Uri.joinPath(
				baseUri,
				"src",
				headCommit ?? "",
				filepath,
			).with({
				query: `at=${headSymbolic}`,
				fragment: `lines-${line}`,
			})
		: vscode.Uri.joinPath(
				baseUri,
				"/blob", ref ?? "",
				filepath,
			).with({
				fragment: `${line}`,
			});

	const debugFile = await vscode.workspace.openTextDocument({
		content: JSON.stringify({
			fileName: editor.document.fileName,
			filepath,
			toplevel,
			lineStart,
			lineEnd,
			headCommit,
			headSymbolic,
			ref,
			customUrlVariables,
			customUrl,
			generatedCustomUrl: generatedCustomUrl.toString(),
			remote,
			remoteUrl,
			baseUri: baseUri.toString(),
			isBitbucket,
			line,
			uri: uri.toString(),
		}, null, 2)
	});
	vscode.window.showTextDocument(debugFile);
}

async function openCurrentLine(...opts: Parameters<typeof getCurrentLine>) {
	const uri = await getCurrentLine(...opts);
	if (uri !== undefined) {
		await vscode.env.openExternal(uri);
	}
}

async function copyCurrentLine(...opts: Parameters<typeof getCurrentLine>) {
	const uri = await getCurrentLine(...opts);
	if (uri !== undefined) {
		await vscode.env.clipboard.writeText(uri.toString(true));
	}

	const barItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, Number.MAX_SAFE_INTEGER - 1000);
	barItem.text = "Successfully copied to clipboard!";
	barItem.color = "green";
	barItem.show();
	setTimeout(() => barItem.dispose(), 2000);
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.commands.registerCommand('gitgps.openCurrentLine', openCurrentLine),
		vscode.commands.registerCommand(
			'gitgps.openCurrentLinePermalink',
			() => openCurrentLine({ permalink: true })
		),
		vscode.commands.registerCommand('gitgps.copyCurrentLine', copyCurrentLine),
		vscode.commands.registerCommand(
			'gitgps.copyCurrentLinePermalink',
			() => copyCurrentLine({ permalink: true })
		),
		vscode.commands.registerCommand(
			"gitgps.debug.showLineDebugInfo",
			showLineDebugInfo,
		)
	);
}

// This method is called when your extension is deactivated
export function deactivate() {}
