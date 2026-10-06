# Hyphen development plan

GitHub is the work-tracking source of truth: [reliability roadmap](https://github.com/Al-Yousef/work-updates/issues/1).

Created October 6, 2026. This document records issues and branch workflow; implementation acceptance boxes remain open.

Hyphen needs a reliable development and release process around the app already built: a native Windows interface and weather adapter, the existing background backend, local Codex observation, messaging, and a conversational assistant.

## Verified starting point at backlog creation

- GitHub's default branch is `main`; its `package.json` identifies Work Updates 0.4.0.
- The local working tree identifies Hyphen 0.6.9 and includes substantial modified and untracked source.
- The C++ Windows application currently lives in a sibling project outside this Git repository.
- Existing backend, native, and simulated transport checks are useful evidence. They do not establish physical input behavior or real source-chat delivery for every release.
- There were no existing repository issues or open PRs when this backlog was created.

## Delivery order

1. Import and reconcile the current source into a reproducible baseline without publishing personal data.
2. Establish native/backend CI, deterministic delivery behavior, safe updates, and weather-adapter lifecycle checks.
3. Harden native messaging UX, status semantics, assistant continuity and coordination, diagnostics, and performance.
4. Extend the verified contracts to connected devices after desktop reliability gates pass.

## Work checklist

- [ ] #2: Put the current native and backend source into one reproducible Hyphen baseline
- [ ] #3: Build and verify the native Windows app in CI with a locked toolchain
- [ ] #4: Make Send and Queue outcomes deterministic across Codex ownership and restart
- [ ] #5: Make installation, data migration, and rollback safe after partial failures
- [ ] #6: Harden the weather-tile adapter lifecycle and restore Windows behavior on failure
- [ ] #7: Make native chat composition, navigation, and accessibility consistently responsive
- [ ] #8: Create a repeatable native end-to-end regression suite with real input evidence
- [ ] #9: Define clear status, waiting ownership, and current-task summary semantics
- [ ] #10: Ground assistant memory and chat retrieval in retained user evidence
- [ ] #11: Make assistant-to-chat coordination explicit, source-bound, and receipt-backed
- [ ] #12: Add correlated diagnostics and actionable connection recovery
- [ ] #13: Measure and enforce whole-app idle and interaction performance budgets

### Deferred connected-device work

- [ ] #14: Specify connected-device parity and verify Mac/iPhone contracts before expansion

## Issue branches and merge prerequisites

| Issue | Priority | Work | Branch | Merge after |
| --- | --- | --- | --- | --- |
| [#2](https://github.com/Al-Yousef/work-updates/issues/2) | P0 | Put the current native and backend source into one reproducible Hyphen baseline | `chore/source-baseline` | First |
| [#3](https://github.com/Al-Yousef/work-updates/issues/3) | P0 | Build and verify the native Windows app in CI with a locked toolchain | `ci/native-build-gates` | #2 |
| [#4](https://github.com/Al-Yousef/work-updates/issues/4) | P0 | Make Send and Queue outcomes deterministic across Codex ownership and restart | `fix/delivery-contract` | #2 |
| [#5](https://github.com/Al-Yousef/work-updates/issues/5) | P0 | Make installation, data migration, and rollback safe after partial failures | `fix/transactional-updates` | #2, #3, #4 |
| [#6](https://github.com/Al-Yousef/work-updates/issues/6) | P0 | Harden the weather-tile adapter lifecycle and restore Windows behavior on failure | `fix/weather-adapter-lifecycle` | #2, #3 |
| [#7](https://github.com/Al-Yousef/work-updates/issues/7) | P1 | Make native chat composition, navigation, and accessibility consistently responsive | `ux/native-chat-interactions` | #2, #4, #6 |
| [#8](https://github.com/Al-Yousef/work-updates/issues/8) | P1 | Create a repeatable native end-to-end regression suite with real input evidence | `test/native-e2e-matrix` | #2, #3, #4, #6, #7 |
| [#9](https://github.com/Al-Yousef/work-updates/issues/9) | P1 | Define clear status, waiting ownership, and current-task summary semantics | `feat/status-summary-contract` | #2, #4 |
| [#10](https://github.com/Al-Yousef/work-updates/issues/10) | P1 | Ground assistant memory and chat retrieval in retained user evidence | `feat/assistant-memory-quality` | #2 |
| [#11](https://github.com/Al-Yousef/work-updates/issues/11) | P1 | Make assistant-to-chat coordination explicit, source-bound, and receipt-backed | `feat/assistant-coordination` | #2, #4, #10 |
| [#12](https://github.com/Al-Yousef/work-updates/issues/12) | P1 | Add correlated diagnostics and actionable connection recovery | `feat/diagnostic-bundles` | #2, #4 |
| [#13](https://github.com/Al-Yousef/work-updates/issues/13) | P1 | Measure and enforce whole-app idle and interaction performance budgets | `perf/process-budget-audit` | #2, #3, #8, #12 |
| [#14](https://github.com/Al-Yousef/work-updates/issues/14) | P2 | Specify connected-device parity and verify Mac/iPhone contracts before expansion | `feat/connected-device-contract` | #2, #4, #5, #9, #11 |

The current implementation is on `chore/source-baseline`: [source baseline PR #15](https://github.com/Al-Yousef/work-updates/pull/15). It imports the existing backend and native Windows source into one checkout. Later issue branches should be created from the baseline after it merges.

## Work that can progress independently

After #2 merges, #3 (build), #4 (delivery), and #10 (memory) can progress in separate checkouts. After #4, #9 (statuses) and #12 (diagnostics) can own their separate modules. #6 and #7 merge in order because they share the native window controller. #11 follows the delivery and memory contracts. #8 verifies the integrated native behavior, then #13 measures it. #14 stays deferred until the desktop foundation is reliable.

Use the dependency table as merge gates; split any issue into smaller PRs if necessary, without widening another branch's scope.

## Branch and merge workflow

- Start with `chore/source-baseline` from `main`. Audit and import the current source there; do not use a blanket add of the dirty directory.
- Start each later issue branch from the updated `main` after its prerequisites merge. Use a separate checkout per active branch.
- One issue-sized change per PR; reference its issue and use `Closes #N` when all acceptance criteria are satisfied.
- Squash merge reviewed PRs into `main`; refresh remaining branches from `main`. A dependent stacked PR must name its temporary base and be retargeted/revalidated after the prerequisite lands.
- Changes to shared integration files, protocol schemas, or the same native controller must be coordinated and merged in order. Independent branches should own separate modules and tests.
- Each PR reports what was actually tested: model/unit, isolated transport, native UI, physical desktop, or real Codex delivery. A synthetic receipt is not real-chat delivery evidence.
- Require the relevant automated checks before merge. Release installation additionally requires idle-state checks, preserved data, package/source hashes, and recovery evidence.
- Keep personal conversations, app data, credentials, private logs, downloaded toolchains, and generated binaries out of commits and public issue evidence.

## Completion

This tracker closes when the desktop foundation and reliability issues pass their acceptance gates on the integrated app. Connected-device expansion stays a separate later milestone. This issue creates the work plan; it does not claim that the implementation or CI settings have already been changed.
