# Tape Transcript Projection Implementation Plan

Spec: [spec.md](./spec.md). One branch, one PR; each slice below is one reviewable commit that
leaves `pnpm typecheck` and the session/tape suites green on its own.

## Slice 1: Make idempotent message appends observable

- [x] In `factPersistence.ts` `appendMessageRecordToTape`, compare the returned row's
      `payload.record` with the record when the provenance key was derived; warn once with session
      id, message id, source and differing field names (`content`, `status`, `orderSeq`,
      `metadata`). Skip the comparison when the stored `payload_json` equals the serialized payload.
- [x] Guard test: identical re-append logs nothing; a re-append with different content logs one
      warning naming `content`.

Completion: the warning exists and fires only on divergence. No behavior change for callers.

## Slice 2a: Canonical record on shared table mappings

- [x] Move the persist and read field mappings for user files and assistant blocks into
      `src/main/session/data/messageContent.ts`; `deepchat_assistant_blocks.replaceForMessage`,
      `persistUserContent` and `materializeContent` use them.
- [x] Add `canonicalizeMessageContent(role, rawContent, updatedAt)` on top of those mappings.
- [x] Round-trip guard test against real SQLite: the canonical string equals what the tables return
      after persisting the raw content, for user content with files, links, active skills and inline
      items, and for assistant blocks covering reasoning, tool call, image, action and error shapes
      including a block without a timestamp. The test runs in the native Tape storage CI step.

Completion: one mapping per direction; the canonical form is pinned to the tables' behavior.

## Slice 2b: The applier as the single terminal writer

- [ ] Add `TranscriptProjectionApplier` (`transcriptProjection.ts`) with `applyRecord` and
      `applyRetraction`; move the table-writing bodies of the terminal methods into it.
- [ ] Route every terminal method in `SessionTranscript` through the applier while keeping the
      current order (tables, read back, fact). Behavior is unchanged in this slice.

Completion: `SessionTranscript` no longer writes terminal rows directly; all existing tests pass.

## Slice 3: Fact-first terminal writes

- [ ] Reorder every method in the spec's write-direction table: canonical record in memory, fact
      append, `applyRecord`/`applyRetraction`. Remove `appendLiveTapeFacts`.
- [ ] Fork: `cloneSentMessagesToSession` appends `message/<role>` facts with `meta.source = 'fork'`
      before applying.
- [ ] `recoverPendingMessages` and legacy import `backfillMessageRow` append their facts before
      applying; the table-level `deepchatMessages.recoverPendingMessages` is removed if unused.
- [ ] `prepareRetryMessage` restores the prompt through a replacement fact
      (`reason: 'retry_restored_prompt'`) instead of `updateMessageStatus`.
- [ ] Acceptance test: after each terminal write, `getMessage(id)` deep-equals the latest effective
      fact record (except `traceCount`); fork/recover/import/retry leave no fact-less row.

Completion: no transcript terminal write happens without its fact in the same transaction.

## Slice 4: Projection cursor, replay and head-comparison readiness

- [ ] Add `deepchat_transcript_projection_meta` table and registration in `SessionDatabase`;
      `clearMessages` deletes the row in its transaction.
- [ ] Every fact-first write advances the row to the Tape head in the same transaction.
- [ ] `TranscriptProjectionApplier.replay(sessionId, afterEntryId)` over effective message input
      rows: message facts via `applyRecord`, retractions via `applyRetraction`, compaction
      indicators skipped; UPSERT-only.
- [ ] `TapeReconcilerService.ensureSessionTapeReady` implements readiness steps 1–5 from the spec:
      one head query, one-time legacy backfill for absent meta, incarnation mismatch handling,
      incremental replay, unchanged `historyRecords`. Remove the `reconciled` map and
      `digestTranscript`.
- [ ] Tests: unchanged Session performs no transcript read (spy on `getMessages`); absent meta with
      transcript rows backfills once and deletes nothing; meta deleted plus a direct Tape append
      materializes the message; incarnation mismatch re-runs the backfill.

Completion: `ensureSessionTapeReady` is O(delta) and the transcript digest is gone.

## Slice 5: Documentation and test alignment

- [ ] `docs/architecture/tape-system.md`: lines 26–27 describe the transcript as the derived
      projection and UI read model of Context Tape message facts; the "Message projection 与 Context
      facts" section states fact-first order and the one-time migration backfill.
- [ ] Rewrite `tapeReconciler.test.ts` cases that assert transcript-bypass backfill into projection
      replay cases; keep the tool-revision and legacy-summary cases.
- [ ] Update `tapeTestHarness.ts` / `tapeTableMockContract.test.ts` only where the new meta table or
      applier needs a mock surface.

Completion: docs match code; no test asserts the removed backfill direction.

## Whole-change review and gates

- [ ] Review against the spec for hidden side effects, compatibility, failure behavior,
      performance, security, naming and maintenance cost before each commit.
- [ ] `pnpm run format`, `pnpm run i18n`, `pnpm run lint`, `pnpm run typecheck`.
- [ ] `test/main/session`, `test/main/tape`, `test/main/agent/deepchat`; real-SQLite contract
      suites under the Electron ABI.
- [ ] Manual: new chat, resume, edit, delete, steer, manual compaction, fork, legacy import; compare
      Inspector rows with the UI.
