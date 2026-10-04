# ChatGPT DOM regression samples

These reduced, sanitized fixtures preserve the structural attributes observed in
legacy ChatGPT and the September 2026 search-unit renderer. All message contents,
IDs and transport markers are synthetic. These are not full production page dumps.

- `legacy.html`: turn wrappers, legacy identities and a nested XML code block.
- `modern.html`: search-unit groups, nonconsecutive block positions, new composer.
- `mixed.html`: modern wrappers around legacy messages; count each message once.
- `generating.html`: stop button, request placeholder and an unassigned reply ID.
- `error.html`: legacy and modern request placeholders are not assistant replies.
- `virtualized.html`: only the last group of a long conversation is mounted.
- `unknown.html`: deliberate future-format mutation; never infer roles from text.

Run `npm run test:chatgpt-dom` with Chrome installed (or set `WTAGENT_CHROME_PATH`).
No account, user profile or network access is needed. Tests intercept navigation
and load these files in an isolated headless browser. The CI browser job installs
a pinned Playwright Chromium build using the repository's locked dependency.

When a site change breaks recognition, reduce a page sample to the relevant
attributes, replace all contents/identities/URLs, add it here, and test the actual
adapter's selectors and recovery boundary before changing the registry.
