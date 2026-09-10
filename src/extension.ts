import * as path from "node:path";
import * as ts from "typescript";
import * as vscode from "vscode";

/** Custom URI scheme backing the read-only virtual declaration documents. */
const SCHEME = "dts-view";

/** Command id contributed in package.json. */
const COMMAND_ID = "dts-view.openBeside";

/**
 * A single, fixed URI for the preview — like Markdown's "Open Preview to the Side", there is one
 * persistent panel that re-targets to whichever source file you're on, rather than one tab per
 * file. Because the URI never changes, VS Code always updates the same tab in place. (The tab
 * label is derived from this path and can't be renamed per-file — a text editor tab has no title
 * API — so the mirrored file is named in a header comment inside the content instead.)
 */
const PREVIEW_URI = vscode.Uri.from({ scheme: SCHEME, path: "/DTS Preview.d.ts" });

/**
 * Debounce before regenerating the preview as the user types (or switches files). A refresh is an
 * incremental `LanguageService` emit (only the changed file re-parses), but there's no point
 * running it on every keystroke — coalesce bursts into one.
 */
const LIVE_UPDATE_DEBOUNCE_MS = 300;

/**
 * TypeScript stores file names in a case-canonicalized, forward-slash form. We compare the paths
 * TypeScript hands our `LanguageServiceHost` against the open editor buffers using the same
 * canonicalization, or the buffer substitution silently misses on Windows (backslashes) and on
 * case-insensitive file systems.
 */
const useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames;
function toCanonicalPath(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	return useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

/**
 * Read-only content provider for the `dts-view:` scheme. Content is pushed in by the controller
 * (generated on demand) and cached by URI; firing `onDidChange` is what refreshes the open tab
 * in place.
 */
class DtsContentProvider implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

	/** Fired to tell VS Code to re-pull content for an already-open virtual document. */
	readonly onDidChange = this.onDidChangeEmitter.event;

	/**
	 * Store (or replace) the declaration text for a URI. Fires `onDidChange` only when the
	 * document already existed — for a brand-new URI the subsequent `openTextDocument` pull
	 * is what first reads the content, so firing would be redundant (and premature).
	 */
	set(uri: vscode.Uri, text: string): void {
		const key = uri.toString();
		const existed = this.contents.has(key);
		this.contents.set(key, text);
		if (existed) {
			this.onDidChangeEmitter.fire(uri);
		}
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? "";
	}

	dispose(): void {
		this.onDidChangeEmitter.dispose();
		this.contents.clear();
	}
}

/**
 * Prepend a one-line header naming the file the (single, retargeting) panel currently mirrors.
 * The panel follows the active editor, so without this you couldn't tell which file's declarations
 * you're looking at — the tab title is fixed (see {@link PREVIEW_URI}). It's a comment, so the view
 * is still valid TypeScript.
 */
function buildPreviewContent(sourceUri: vscode.Uri, dtsText: string): string {
	const label = vscode.workspace.asRelativePath(sourceUri);
	return `// DTS View — ${label} (read-only, live preview)\n\n${dtsText}`;
}

/**
 * Reject anything that isn't an implementation `.ts`/`.tsx` file. Returns a user-facing error
 * message when the document is unsupported, or `undefined` when it's good to process.
 */
function validateSource(document: vscode.TextDocument): string | undefined {
	const lower = document.uri.path.toLowerCase();
	if (/\.d\.[cm]?ts$/.test(lower)) {
		return "The active file is already a declaration file (.d.ts).";
	}
	if (!/\.tsx?$/.test(lower)) {
		return "Only .ts and .tsx files are supported.";
	}
	return undefined;
}

/**
 * Sensible defaults when no tsconfig.json is found. The emit-controlling options are layered on
 * afterwards in {@link buildEmitOptions}, so these are only the "how to understand the code" settings.
 */
function defaultCompilerOptions(): ts.CompilerOptions {
	return {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		jsx: ts.JsxEmit.Preserve,
		strict: true,
		esModuleInterop: true,
		skipLibCheck: true,
	};
}

/**
 * Layer the declaration-emit settings on top of the project's own options. We preserve the
 * project's options wherever possible and only override what's needed to get a single-file
 * `.d.ts` out of a preview:
 * - declaration/emitDeclarationOnly/noEmit: the core "emit only declarations" trio (many projects
 *   set `noEmit` because a bundler owns emit — we must turn it back on).
 * - declarationMap: off — there's no navigation feature, so a `//# sourceMappingURL` pointing at a
 *   map we never emit would just be a dangling reference.
 * - isolatedDeclarations: off — the `LanguageService` has complete cross-file type info, so the
 *   per-file isolated-declaration constraints don't apply and would only surface spurious
 *   "type cannot be named" diagnostics that block an otherwise-derivable preview.
 * - composite/incremental/tsBuildInfoFile: off — a preview must not read or write a `.tsbuildinfo`.
 */
function buildEmitOptions(projectOptions: ts.CompilerOptions): ts.CompilerOptions {
	return {
		...projectOptions,
		declaration: true,
		emitDeclarationOnly: true,
		noEmit: false,
		declarationMap: false,
		isolatedDeclarations: false,
		composite: false,
		incremental: false,
		tsBuildInfoFile: undefined,
	};
}

/**
 * Resolve the compiler options from the nearest tsconfig.json — `extends`, path mappings, `jsx`,
 * and module resolution all applied via TypeScript's own config parser — or sensible defaults when
 * there's none. Only the *options* are taken from the config; the preview is rooted at the open
 * editor buffers rather than the whole project file list (see {@link TsProject}).
 */
function loadCompilerOptions(configPath: string | undefined): ts.CompilerOptions {
	if (!configPath) {
		return buildEmitOptions(defaultCompilerOptions());
	}
	const read = ts.readConfigFile(configPath, ts.sys.readFile);
	if (read.error || !read.config) {
		return buildEmitOptions(defaultCompilerOptions());
	}
	// parseJsonConfigFileContent resolves `extends`, include/exclude globs, and path mappings
	// against the config's own directory using ts.sys as the host.
	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), undefined, configPath);
	return buildEmitOptions(parsed.options);
}

/** Collapse a handful of diagnostics into one concise, single-line-ish message for a toast. */
function summarizeDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const diagnostic of diagnostics) {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
		if (seen.has(message)) {
			continue;
		}
		seen.add(message);
		if (diagnostic.file && diagnostic.start !== undefined) {
			const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
			parts.push(`${path.basename(diagnostic.file.fileName)}:${line + 1}:${character + 1} - ${message} (TS${diagnostic.code})`);
		} else {
			parts.push(`${message} (TS${diagnostic.code})`);
		}
		if (parts.length >= 3) {
			break;
		}
	}
	return parts.join(" • ");
}

type DeclarationResult = { text: string } | { error: string };

/** Cache key for the "no tsconfig found" project. */
const NO_CONFIG_KEY = "\0no-tsconfig";

/**
 * A persistent TypeScript project backed by a `LanguageService` — the same engine `tsserver` uses.
 * Created once per tsconfig and reused across every file in that project and across every keystroke:
 * the `DocumentRegistry` caches parsed/bound source files and the default libraries, so a refresh
 * only re-parses the file(s) whose version actually changed instead of rebuilding the world. This
 * is the difference between a multi-second freeze per keystroke and a few milliseconds.
 *
 * The program is rooted at the *open editor buffers* (not the whole `tsconfig` file list), which
 * keeps warm-up and memory bounded on large monorepos while still following imports transitively —
 * so inferred exported types resolve with project-wide type information. The one gap is a
 * project-global ambient declaration the file neither imports nor pulls in via `types`/`typeRoots`;
 * that's rare, and the price of not parsing thousands of files on every edit.
 */
class TsProject {
	private readonly options: ts.CompilerOptions;
	private readonly currentDirectory: string;
	private readonly service: ts.LanguageService;
	/** Open editor buffers keyed by canonical path — the live, unsaved text the service should see. */
	private readonly openBuffers = new Map<string, { fileName: string; text: string; version: number }>();
	/** Root file names for the current emit (the target plus any other open `.ts`/`.tsx` buffers). */
	private rootFileNames: string[] = [];

	constructor(configPath: string | undefined) {
		this.options = loadCompilerOptions(configPath);
		this.currentDirectory = configPath ? path.dirname(configPath) : ts.sys.getCurrentDirectory();

		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => this.rootFileNames,
			getScriptVersion: (fileName) => {
				// Open buffers change as you type (VS Code bumps `version`); on-disk files are treated
				// as immutable within a session so the registry parses each one exactly once. An
				// external edit to a file you don't have open needs a reload — a deliberate speed trade.
				const open = this.openBuffers.get(toCanonicalPath(fileName));
				return open ? `open:${open.version}` : "disk";
			},
			getScriptSnapshot: (fileName) => {
				const open = this.openBuffers.get(toCanonicalPath(fileName));
				if (open) {
					return ts.ScriptSnapshot.fromString(open.text);
				}
				const text = ts.sys.readFile(fileName);
				return text !== undefined ? ts.ScriptSnapshot.fromString(text) : undefined;
			},
			fileExists: (fileName) => this.openBuffers.has(toCanonicalPath(fileName)) || ts.sys.fileExists(fileName),
			readFile: (fileName, encoding) => {
				const open = this.openBuffers.get(toCanonicalPath(fileName));
				return open ? open.text : ts.sys.readFile(fileName, encoding);
			},
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			realpath: ts.sys.realpath,
			getCurrentDirectory: () => this.currentDirectory,
			// Return the *same* options object every call: the DocumentRegistry keys cached files by
			// a hash of these settings, so a stable reference keeps the cache warm.
			getCompilationSettings: () => this.options,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			useCaseSensitiveFileNames: () => useCaseSensitiveFileNames,
		};

		this.service = ts.createLanguageService(
			host,
			ts.createDocumentRegistry(useCaseSensitiveFileNames, this.currentDirectory),
		);
	}

	/** Generate the `.d.ts` for one file from the current editor buffers. */
	emitDeclaration(targetFileName: string): DeclarationResult {
		this.syncOpenBuffers(targetFileName);

		// getEmitOutput is in-memory by design — nothing is ever written to disk.
		const output = this.service.getEmitOutput(targetFileName, /*emitOnlyDtsFiles*/ true);
		const declaration = output.outputFiles.find((file) => /\.d\.[cm]?ts$/.test(file.name));
		if (declaration && declaration.text.length > 0) {
			return { text: declaration.text };
		}

		// No usable output — surface why (usually a syntax error while mid-typing).
		const diagnostics = [
			...this.service.getSyntacticDiagnostics(targetFileName),
			...this.service.getSemanticDiagnostics(targetFileName),
		];
		return {
			error: summarizeDiagnostics(diagnostics) || "TypeScript produced no declaration output for this file.",
		};
	}

	/** Snapshot the open editor buffers and choose the program roots for this emit. */
	private syncOpenBuffers(targetFileName: string): void {
		this.openBuffers.clear();
		const roots: string[] = [];
		const targetCanonical = toCanonicalPath(targetFileName);
		let targetIsRoot = false;
		for (const document of vscode.workspace.textDocuments) {
			if (document.uri.scheme !== "file") {
				continue;
			}
			const fileName = document.uri.fsPath;
			const canonical = toCanonicalPath(fileName);
			this.openBuffers.set(canonical, { fileName, text: document.getText(), version: document.version });
			if (/\.tsx?$/i.test(fileName)) {
				roots.push(fileName);
				targetIsRoot ||= canonical === targetCanonical;
			}
		}
		if (!targetIsRoot) {
			roots.push(targetFileName);
		}
		this.rootFileNames = roots;
	}

	dispose(): void {
		this.service.dispose();
	}
}

/**
 * Caches one {@link TsProject} per resolved tsconfig, so previewing files in the same project
 * reuses its warm `LanguageService` (and its parsed-file cache) across edits and file switches.
 */
class DeclarationService {
	private readonly projects = new Map<string, TsProject>();
	/** Memoized upward tsconfig lookup, keyed by directory. */
	private readonly configForDir = new Map<string, string | undefined>();

	generate(document: vscode.TextDocument): DeclarationResult {
		return this.projectFor(document.uri.fsPath).emitDeclaration(document.uri.fsPath);
	}

	/** Drop all cached projects — call when a tsconfig changes so options are re-read. */
	reset(): void {
		for (const project of this.projects.values()) {
			project.dispose();
		}
		this.projects.clear();
		this.configForDir.clear();
	}

	dispose(): void {
		this.reset();
	}

	private projectFor(fileName: string): TsProject {
		const configPath = this.resolveConfig(path.dirname(fileName));
		const key = configPath ?? NO_CONFIG_KEY;
		let project = this.projects.get(key);
		if (!project) {
			project = new TsProject(configPath);
			this.projects.set(key, project);
		}
		return project;
	}

	private resolveConfig(directory: string): string | undefined {
		if (this.configForDir.has(directory)) {
			return this.configForDir.get(directory);
		}
		const configPath = ts.findConfigFile(directory, ts.sys.fileExists, "tsconfig.json");
		this.configForDir.set(directory, configPath);
		return configPath;
	}
}

/**
 * Owns the single, persistent preview panel (see {@link PREVIEW_URI}) and keeps it in sync,
 * Markdown-preview style:
 * - the command points the panel at the active file and reveals it beside the source;
 * - while the panel is open it **follows** the active editor — switching to another `.ts`/`.tsx`
 *   retargets the same panel instead of opening a new tab;
 * - typing in the mirrored source live-updates it (debounced).
 *
 * Live regeneration is triggered by the mirrored file's own edits and by editor switches. Because
 * the underlying {@link DeclarationService} reads *all* open buffers, an unsaved edit in an imported
 * file is reflected on the next refresh too; only files you don't have open are read from disk.
 */
class DtsPreviewController {
	/** URI of the source file the panel currently mirrors, or undefined when the panel is closed. */
	private currentSource: vscode.Uri | undefined;
	/** Whether the preview panel is currently open (drives whether we follow the active editor). */
	private panelOpen = false;
	/** Pending debounced refresh, if any. */
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly provider: DtsContentProvider,
		private readonly declarations: DeclarationService,
	) {}

	/**
	 * Command entry point: (re)target the single panel to a source document and reveal it beside
	 * the source without stealing focus. Returns an error message when generation fails (so the
	 * caller can surface it), or undefined on success.
	 */
	async showPreviewFor(sourceDocument: vscode.TextDocument): Promise<string | undefined> {
		const result = this.declarations.generate(sourceDocument);
		if ("error" in result) {
			return result.error;
		}
		this.currentSource = sourceDocument.uri;
		this.provider.set(PREVIEW_URI, buildPreviewContent(sourceDocument.uri, result.text));

		let previewDocument = await vscode.workspace.openTextDocument(PREVIEW_URI);
		if (previewDocument.languageId !== "typescript") {
			// Custom-scheme docs aren't always language-detected from their path; force TS highlighting.
			// setTextDocumentLanguage returns a fresh document instance for the same URI.
			previewDocument = await vscode.languages.setTextDocumentLanguage(previewDocument, "typescript");
		}

		// Reveal in the column the panel already occupies (so repeat runs don't keep splitting the
		// editor); otherwise open beside the source. preserveFocus keeps the cursor in the source,
		// matching Markdown's "Open Preview to the Side".
		const existingColumn = vscode.window.visibleTextEditors.find(
			(editor) => editor.document.uri.toString() === PREVIEW_URI.toString(),
		)?.viewColumn;
		await vscode.window.showTextDocument(previewDocument, {
			viewColumn: existingColumn ?? vscode.ViewColumn.Beside,
			preview: false,
			preserveFocus: true,
		});
		this.panelOpen = true;
		return undefined;
	}

	/** Typing in the mirrored source file → debounced refresh. */
	onSourceChanged(event: vscode.TextDocumentChangeEvent): void {
		if (!this.panelOpen || !this.currentSource) {
			return;
		}
		// Ignore our own virtual doc (its content is pushed, not typed) and no-op events.
		if (event.document.uri.scheme === SCHEME || event.contentChanges.length === 0) {
			return;
		}
		if (event.document.uri.toString() !== this.currentSource.toString()) {
			return;
		}
		this.scheduleRefresh();
	}

	/** Active editor changed → follow it (Markdown-style) while the panel is open. */
	onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
		if (!this.panelOpen || !editor) {
			return;
		}
		const uri = editor.document.uri;
		// The panel itself gaining focus, or a non-.ts/.tsx (or .d.ts) file, leaves the panel as-is.
		if (uri.scheme === SCHEME || validateSource(editor.document)) {
			return;
		}
		if (this.currentSource && uri.toString() === this.currentSource.toString()) {
			return;
		}
		this.currentSource = uri;
		this.scheduleRefresh();
	}

	/** Closing the preview tab stops following and cancels any pending rebuild. */
	onDocumentClosed(document: vscode.TextDocument): void {
		if (document.uri.toString() !== PREVIEW_URI.toString()) {
			return;
		}
		this.panelOpen = false;
		this.currentSource = undefined;
		this.clearTimer();
	}

	private scheduleRefresh(): void {
		this.clearTimer();
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			this.refresh();
		}, LIVE_UPDATE_DEBOUNCE_MS);
	}

	private refresh(): void {
		if (!this.currentSource) {
			return;
		}
		const sourceKey = this.currentSource.toString();
		// Re-resolve the document at fire time so we read the latest text and skip a closed source.
		const document = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === sourceKey);
		if (!document) {
			return;
		}
		const result = this.declarations.generate(document);
		// Mid-typing the file is often transiently un-parseable. Keep the last good output rather
		// than clobbering it with an error (and don't toast on every keystroke); the view snaps back
		// to correct once the code parses again. The manual command still surfaces errors.
		if ("error" in result) {
			return;
		}
		this.provider.set(PREVIEW_URI, buildPreviewContent(document.uri, result.text));
	}

	private clearTimer(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
	}

	dispose(): void {
		this.clearTimer();
	}
}

/** The `DTS View: Open Beside` command. */
async function openBeside(controller: DtsPreviewController): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		void vscode.window.showErrorMessage("DTS View: No active editor — open a .ts or .tsx file first.");
		return;
	}

	const validationError = validateSource(editor.document);
	if (validationError) {
		void vscode.window.showErrorMessage(`DTS View: ${validationError}`);
		return;
	}

	const error = await controller.showPreviewFor(editor.document);
	if (error) {
		void vscode.window.showErrorMessage(`DTS View: ${error}`);
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const provider = new DtsContentProvider();
	const declarations = new DeclarationService();
	const controller = new DtsPreviewController(provider, declarations);
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
		provider,
		declarations,
		controller,
		vscode.commands.registerCommand(COMMAND_ID, () => openBeside(controller)),
		vscode.workspace.onDidChangeTextDocument((event) => controller.onSourceChanged(event)),
		vscode.workspace.onDidCloseTextDocument((document) => controller.onDocumentClosed(document)),
		vscode.window.onDidChangeActiveTextEditor((editor) => controller.onActiveEditorChanged(editor)),
		// A changed tsconfig means different compiler options — drop cached projects so they re-read.
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (/(^|\/)tsconfig[^/]*\.json$/.test(document.uri.path)) {
				declarations.reset();
			}
		}),
	);
}

export function deactivate(): void {
	// Nothing to clean up beyond the disposables registered in `activate`.
}
