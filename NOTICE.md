# Implementation provenance and dependency boundary

The current design runtime is implemented in `src/design-runtime/` using browser DOM APIs.
The build bundles only files from that directory. It does not bundle React, ReactDOM, Babel,
BaoCut, or the previous reconstructed Claude Design runtime, and does not download a runtime from a CDN.

The earlier copied implementations of the validators, asset store, shared metadata helpers,
tool descriptions, and design skills have been replaced by local implementations and documentation.
The old `vendor/support.js` artifact and its external-checkout build script have been removed.
A local symlink at the former artifact path points to the new build for already-running services;
it contains no legacy implementation and is excluded from distribution.
Existing `.dc.html` / canvas v3 files, source node IDs and annotation names are compatibility interfaces.
Keeping an interface name does not load the old implementation.

## Dependencies that remain

- DeepSeek Harness and its host plugin APIs are required to run this Harness plugin.
- The sidebar uses the React/ReactDOM and UI primitives supplied by Harness. Those libraries are
  not part of the standalone artboard runtime and are not bundled into exported designs.
- TypeScript, esbuild, Node type declarations, and Playwright are build/test tools with their own licenses.
- Node, the browser engine, fonts, and user-supplied assets or scripts retain their own terms.

This change is an implementation migration, not a declaration that the repository has no third-party
platform dependencies or a legal certification of unrestricted redistribution. The implementation work
used the existing file contracts and tests; it was not a separately staffed clean-room process.
Historical Git revisions still contain the former files and their provenance. Do not treat this notice
as relicensing those revisions. Choose a project license separately if publishing this repository.
