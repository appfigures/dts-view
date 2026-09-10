# DTS View

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/oztune.dts-view?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=oztune.dts-view)
[![Open VSX](https://img.shields.io/open-vsx/v/oztune/dts-view?label=Open%20VSX)](https://open-vsx.org/extension/oztune/dts-view)

A tiny VS Code extension with one command:

**`DTS View: Open Beside`** — generates the `.d.ts` declaration for the active `.ts`/`.tsx`
file and shows it in a **single, persistent read-only panel beside** the source — like Markdown's
"Open Preview to the Side". The panel **follows the active editor** and **live-updates as you type**,
so there's only ever one preview tab. Nothing is written to disk.

```
foo.ts                          foo.d.ts  (virtual, read-only)
------------------------        ------------------------------
import type { Foo } from        import type { Foo } from "./types";
  "./types";                    export declare function makeFoo(): Foo;
export function makeFoo()       export interface Bar {
  : Foo { ... }                     foo: Foo;
export interface Bar {          }
  foo: Foo;
}
```

## Install

Open the Extensions view and search **DTS View** — VS Code pulls from the Marketplace; Cursor,
VSCodium, and Gitpod pull from Open VSX. Or from the command line:

```bash
code   --install-extension oztune.dts-view   # VS Code
cursor --install-extension oztune.dts-view   # Cursor
codium --install-extension oztune.dts-view   # VSCodium
```

Then open a `.ts`/`.tsx` file and run **DTS View: Open Beside** (`Cmd/Ctrl+Shift+P`). Updates arrive
automatically through the marketplace, like any other extension.

## How it works

- Registers a `TextDocumentContentProvider` under the custom `dts-view:` URI scheme; the tab is
  read-only because virtual documents have no on-disk backing.
- Walks upward from the active file to the nearest `tsconfig.json` and parses it with TypeScript's
  own config APIs, so `extends`, path mappings, `jsx`, and module resolution all apply. Falls back
  to sensible defaults when there's no config.
- Builds a real TypeScript `Program` rooted at the project's files (not `transpileDeclaration`), so
  inferred exported types can draw on **project-wide** type information across files.
- Uses a custom `CompilerHost` that serves the editor's **current, unsaved** buffer for the active
  file while resolving the rest of the project from disk. Declaration output is captured in memory
  by intercepting `writeFile`.
- **One persistent panel.** The preview lives at a single fixed `dts-view:` URI, so there's only
  ever one tab; running the command again, switching files, or typing all update it **in place**.
  (A text-editor tab can't be renamed per file — no title API — so a one-line header comment names
  the file the panel is currently showing.)
- **Follows the active editor + live-updates** (debounced ~300ms; no save needed). Updates are
  scoped to the mirrored file's own edits and to editor switches; editing a *different* imported
  file won't refresh it. Each refresh rebuilds a full Program, so on a very large project a rebuild
  can lag a beat behind your typing/switching.

## Requirements & versions

- **`typescript` is pinned to `^5.9.3` on purpose.** `typescript@7.x` is the new native (Go) port:
  its main entrypoint exports only a version string and the programmatic compiler API is exposed
  only under an explicitly-unstable `typescript/unstable/*` surface. The classic API this extension
  relies on — `createProgram`, a custom `CompilerHost`, `parseJsonConfigFileContent`, per-file
  `program.emit` — does not exist at the main entrypoint in 7.x. 5.9.x is the latest line that ships
  it. Revisit when the native port stabilizes that API.

## Develop

```bash
npm install
npm run compile   # tsc -> out/extension.js   (npm run watch to rebuild on change)
code .            # then press F5 to launch the Extension Development Host
```

In the `[Extension Development Host]` window, open any `.ts`/`.tsx` file and run
**DTS View: Open Beside**. Type to watch it update, or switch files and the panel follows.

`npm run package` builds a self-contained `.vsix` (it bundles the `typescript` package it needs at
runtime, including the `lib.*.d.ts` files the compiler reads for global types).

## Publishing (maintainer)

Releases are automated: pushing a **`v*` tag** runs `.github/workflows/publish.yml`, which builds
the `.vsix` and publishes the same artifact to the VS Code Marketplace and Open VSX, then attaches
it to a GitHub Release.

```bash
# bump "version" in package.json first, then:
git tag v0.0.1 && git push origin v0.0.1
```

One-time setup:

1. **Icon** — export `icon.svg` to a 128×128 `icon.png` and add `"icon": "icon.png"` to
   `package.json` (Marketplace listings look unfinished without one), e.g.
   `npx svgexport icon.svg icon.png 128:128`.
2. **Marketplace token** — create a publisher named `oztune` (Azure DevOps), generate a PAT scoped
   to *Marketplace → Manage*, and add it as the repo secret `VSCE_PAT`. ⚠️ Global Azure DevOps PATs
   retire **2026-12-01** — after that, switch CI to Microsoft Entra ID auth.
3. **Open VSX token** — sign the Eclipse Publisher Agreement at open-vsx.org, create the `oztune`
   namespace (`npx ovsx create-namespace oztune -p <token>`), and add the token as `OVSX_PAT`.

To publish by hand instead of via CI: `npx vsce publish -p <VSCE_PAT>` and
`npx ovsx publish dts-view-<version>.vsix -p <OVSX_PAT>`.

## Scope

Intentionally small: no source-map/navigation back to source, no settings, no sidebar, no temp
files. Single persistent panel, follow-the-editor, and live update while typing are all in — see
"How it works".
