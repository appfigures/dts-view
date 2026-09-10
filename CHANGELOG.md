# Change Log

## 0.0.1

- Initial release. `DTS View: Open Beside` generates the `.d.ts` for the active `.ts`/`.tsx` file
  and shows it in a single, persistent, read-only panel beside the source — Markdown-preview style.
  The panel follows the active editor and live-updates from the unsaved buffer as you type. Uses a
  real TypeScript `Program` over the nearest `tsconfig.json`, so inferred exported types resolve
  with project-wide type information. Nothing is written to disk.
