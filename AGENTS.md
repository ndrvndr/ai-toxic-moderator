# Project checks

- Write project documentation, explanatory code comments, and commit messages in English. Preserve original-language moderation fixtures and application UI text unless a task explicitly changes them.

- Run `npm run typecheck` (`tsc --noEmit`) after TypeScript changes and before each commit. Diagnose errors in this checkout; do not rely only on a separate built copy.
- Run `npm run format` for code/import formatting, then `npm run check` before finalizing changes.
- Keep source typechecking independent of generated `dist`; emit builds through `tsconfig.build.json`.
- Do not format or rewrite applied SQL migrations; their checksums are immutable.
- Never commit `.env`, generated builds, or node_modules.
- Start each new feature on a feature branch and commit verified work; report any tool restriction that prevents committing.
