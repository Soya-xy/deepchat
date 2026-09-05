# Tape Transcript Projection Specification

## Background

The message transcript (`deepchat_messages` and its five structured side tables) is the UI read
model for a Session. The Context Tape holds the `message/*` facts that context assembly, recall,
replay, Memory ingestion and the Inspector read. Today the transcript produces those facts: every
terminal write in `SessionTranscript` updates the tables first, reads the row back, and appends a
copy of the materialized record as a Tape fact (`transcript.ts` `appendLiveTapeFacts`).

Since a7967db34 the main terminal paths perform both writes in one SQLite transaction, so a
crashed process cannot leave a transcript row without its fact. The remaining consistency gap is
structural rather than transactional:

- Four transcript writes bypass Tape and rely on the reconciler to backfill later: fork
  (`cloneSentMessagesToSession`), startup recovery (`recoverPendingMessages`), legacy chat import
  (`backfillMessageRow`), and the retry path that restores a failed user prompt to `sent`
  (`transcriptMutations.ts` `prepareRetryMessage`). Nothing stops the next such path from being
  added.
- A `sent` record's live fact uses a provenance key derived from the message id only. The store
  returns the existing entry on a key hit without comparing payloads, so a transcript row whose
  content changed without a replacement fact leaves Tape silently stale. No path does this today;
  the guarantee rests on convention.
- `ensureSessionTapeReady` reads the whole transcript on every call to compute a digest and reads
  every Tape message row to return `historyRecords`. Any transcript change, which every user turn
  causes, re-runs an idempotent backfill over all N records. Phase 0 page-cache tuning made this
  cheap per row, but it stays linear in Session length on the main thread.

The Tape model DeepChat follows (tape.systems; `docs/architecture/tape-system.md`) states that
derivatives never replace original facts. With the transcript as the producer, the Tape copy is the
derivative while also serving as the fact source for provider context. This specification reverses
the direction for terminal message state: the fact is appended first and the transcript tables are
derived from it in the same transaction.

## Goals

1. Make the appended `message/*` fact the only producer of terminal transcript state. Every
   terminal transcript write goes through one materialization component whose input is the record
   carried by the fact.
2. Remove the transcript-to-Tape backfill from the per-call reconciler path. Readiness becomes a
   head comparison between the Tape and a transcript projection cursor, with replay of missing
   facts when the projection is behind.
3. Close the four bypass paths by routing them through the same fact-first component.
4. Make a silent fact/transcript divergence observable: an idempotent message append whose stored
   payload differs from the record being appended logs a bounded warning.
5. Keep the persisted Tape format, fact names, provenance keys, hashes, effective-view semantics,
   ViewManifest and replay contracts unchanged. Existing Tapes read identically before and after.

## Non-Goals

- Storing only a content hash in message facts (option "a" from the analysis). Tape keeps the full
  record so recall, replay, Memory and provider context stay self-sufficient.
- Recording streaming intermediate state (`createAssistantMessage` shells, per-chunk
  `updateAssistantContent`, `updateAssistantMetadata`, `updateMessageStatus('pending')`) in Tape.
- Changing `execution/*`, `contract/*`, `context` kind, ViewManifest, Journal, search projection or
  Memory ingestion projection behavior.
- Replacing the N per-message `revisionKind: 'order'` replacement facts written by compaction shift
  with a new fact type.
- Deriving `deepchat_message_traces` or `deepchat_message_search_results` from Tape. They remain
  runtime sidecars keyed by message id; their delete cascade is unchanged.
- Any archive-on-reset behavior. `resetSessionTape` stays a lifecycle exception.

## Design

### Data families after the change

| Family | Role | Producer |
| --- | --- | --- |
| Tape `message/*` facts, `message/retracted` and `message/compaction_indicator` events | Terminal message facts | `TapeMessageFactWriter` called by transcript terminal writes |
| Transcript terminal rows (`deepchat_messages` with status `sent`/`error`, `deepchat_user_messages`, `_files`, `_links`, `deepchat_assistant_blocks`, `deepchat_search_documents`, `deepchat_usage_stats` message rows) | UI read model, derived | `TranscriptProjectionApplier` |
| Transcript pending region (`deepchat_messages` status `pending` and its block rows) | Live streaming buffer | `SessionTranscript` directly, as today |
| Sidecars (`deepchat_message_traces`, `deepchat_message_search_results`) | Runtime evidence | Runtime, as today |

### Canonical record

The fact payload carries `ChatMessageRecord` with `content` in the materialized form the transcript
returns from `getMessage`: user content is the JSON of `{ text, files, links, search, think,
activeSkills?, inlineItems? }` with each file normalized through the same field mapping the tables
use; assistant content is the JSON block array normalized the same way `toAssistantBlock` reads a
block row. Today that form is obtained by writing the tables and reading back. A pure
`canonicalizeMessageContent(role, rawContent, updatedAt)` produces the same string without table
access by applying the persist mapping and the read mapping in memory. Blocks without a
`timestamp` receive `updatedAt`; today they report the block row's own write time, which is the
same instant within the same transaction.

Invariant: for every record `r` produced by the canonicalizer,
`materialize(persist(r)) === r.content`. A guard test pins this for user content with files, links,
active skills and inline items, and for assistant content covering every block type the renderer
persists. Any new persisted field must be added to both mappings or the guard fails. Fields the
tables do not persist today (`artifact`, the `maximum_tool_calls_reached` action type) are dropped
by the canonical form exactly as the read path drops them; the fact carries what the UI can show.

### TranscriptProjectionApplier

Owned by `src/main/session/data/`. It is the only code that writes terminal state into the
transcript tables.

- `applyRecord(record)`: UPSERT `deepchat_messages` (id, session, order, role, content, status,
  is_context_edge, metadata, created_at, updated_at), replace the role tables from `content`,
  upsert the search document for `sent`/`error` rows, and upsert usage stats for assistant rows with
  usage metadata. Compaction marker rows (`metadata.messageType === 'compaction'`) are applied with
  the same UPSERT.
- `applyRetraction(messageId)`: delete the eight message-scoped rows exactly as
  `deleteMessageWithReason` does today, including the two sidecars.
- `replay(sessionId, afterEntryId)`: read effective message input rows with `entry_id >
  afterEntryId`, apply message facts in entry order via `applyRecord(payload.record)`, and apply
  `message/retracted` events via `applyRetraction`. It never deletes a transcript row that Tape has
  not retracted and never touches a `pending` row that has no fact. `message/compaction_indicator`
  events are skipped; compaction marker recovery stays with `reconcileCompactionMessages`, which
  already decides marker state from the reconstruction anchor.

### Write direction for terminal state

Every terminal transcript method builds the canonical record in memory, appends its fact through
`TapeMessageFactWriter`, then calls `applyRecord`, all inside the existing
`runInDatabaseTransaction`. The table write no longer precedes the fact; the read-back before the
fact append disappears.

| Transcript method | Fact | Applier call |
| --- | --- | --- |
| `createUserMessage` | `appendMessageRecord` | `applyRecord` |
| `finalizeAssistantMessage`, `setMessageError` | `appendMessageRecord` (pending shell becomes terminal) | `applyRecord` |
| `insertCompactionMessageRecord`, `updateCompactionMessage` | `appendMessageRecord` (compaction indicator event) | `applyRecord` |
| `appendCompactionOrderShiftFacts` | per-message `appendMessageReplacement('order')` | `applyRecord` per shifted record |
| `markSteerMessagesRead`, `settleSteerMessages`, `failPendingSteerMessages` | `appendMessageReplacement('record')` | `applyRecord` |
| `updateMessageContent` | `appendMessageReplacement('record')` | `applyRecord` |
| `deleteMessageWithReason`, `deleteFromOrderSeq` | `appendMessageRetraction` | `applyRetraction` |
| `prepareRetryMessage` status restore | `appendMessageReplacement('record', reason 'retry_restored_prompt')` | `applyRecord` |
| `cloneSentMessagesToSession` (fork) | `appendMessageRecord` with `meta.source = 'fork'` | `applyRecord` |
| `recoverPendingMessages` | `appendMessageRecord` (revision key, status `error`) | `applyRecord` |
| legacy import `backfillMessageRow` | `appendMessageRecord` with source `backfill` | `applyRecord` |

Fork does not introduce a `fork/*` fact name; `tape-system.md` records that Tape has no fork writer.
The fork facts are ordinary `message/<role>` facts whose `meta.source` records their origin.

The steer methods keep relying on the caller's `runInTransaction`, as today.

### Projection cursor and readiness

A new table `deepchat_transcript_projection_meta(session_id PRIMARY KEY, tape_incarnation_id,
max_entry_id, projection_version, updated_at)` follows the `deepchat_memory_ingestion_projection_meta`
pattern. Every fact-first write sets the row to the Tape head after its append, in the same
transaction. `clearMessages` deletes the row inside its existing transaction, next to the transcript
delete and the Tape reset.

`ensureSessionTapeReady(sessionId)` becomes:

1. Read `(tape incarnation, tape max entry id)` and the meta row in one query.
2. If the meta row is absent and the transcript has rows: run the existing legacy backfill
   (transcript to Tape, idempotent, `source: 'backfill'`), append the `migration/backfill` event as
   today, then write the meta row. This is the upgrade path for Sessions whose Tape fell behind
   before this change (a fork, import or recovery that was never followed by a turn), and it is what
   keeps the applier from ever replaying an empty Tape over a populated transcript.
3. If the meta row exists but its incarnation differs from the Tape's: the Tape was reset under the
   transcript. Delete the meta row and fall through to step 2.
4. If `max_entry_id` is behind the Tape head: `replay(sessionId, max_entry_id)`, then advance the
   row to the head. Non-message appends (manifests, journal, anchors) advance the cursor with an
   empty replay.
5. Return `historyRecords` from the effective Tape view as today.

The in-process `reconciled` map and the transcript digest are removed. The result type
`TapeBackfillResult` keeps its shape; `appendedFactCount` counts facts appended by step 2.

### Idempotent payload guard

`appendMessageRecordToTape` compares the row the store returned with the record it tried to
append whenever the provenance key was derived (a `sent` record appended live or by backfill). If
`content`, `status`, `orderSeq` or `metadata` differ, it logs one warning with the session id,
message id, source and the names of the differing fields. Payload text is never logged. The append
result is unchanged; the guard only makes a divergence visible.

### Ownership and layering

| Component | Location |
| --- | --- |
| `canonicalizeMessageContent` and the persist/read field mappings | `src/main/session/data/messageContent.ts` (pure) |
| `TranscriptProjectionApplier` | `src/main/session/data/transcriptProjection.ts` |
| `deepchat_transcript_projection_meta` table | `src/main/session/data/tables/deepchatTranscriptProjectionMeta.ts` |
| Reconciler head comparison and migration backfill | `src/main/tape/application/reconcilerService.ts` |
| Payload guard | `src/main/tape/application/factPersistence.ts` |

The applier reads Tape rows through the existing `TapeTranscriptReader`-style port direction: Tape
exposes effective message input rows; session data derives tables from them. Tape code does not
import the applier.

## Compatibility

- No Tape schema, fact name, provenance key, hash version or payload field changes. Records written
  fact-first serialize to the same `payload.record` shape as records read back from the tables did.
- Rollback is a code revert. The meta table is ignored by earlier code; the earlier reconciler's
  backfill finds every fact already present through provenance keys and appends nothing. Fork facts
  with `meta.source = 'fork'` read as ordinary message facts.
- `SessionTranscript`'s public method signatures are unchanged. `TapeBackfillResult` is unchanged.
- The order in which `deepchat_search_documents` and `deepchat_usage_stats` rows are written inside
  a terminal transaction changes; both are read only after commit.
- `deepchat_messages.created_at` for fact-first rows comes from the record instead of the insert
  default. Both were `Date.now()` at the same point.

## Invariants Preserved

1. Tape entries are append-only. Replay writes tables from facts; nothing writes Tape from tables
   except the one-time migration backfill in readiness step 2.
2. Corrections stay appended: edit, delete, steer state and compaction shift remain replacement or
   retraction facts.
3. `context` kind rows never reach the transcript, search or Memory. The applier reads only
   `message` rows and `message/retracted` events.
4. `execution/*` and `contract/*` are untouched; the transcript projection does not join their
   transactions.
5. Replay output (entry order, role, tool pairing, anchor cursor, policy and builder versions,
   synthetic provenance) is unchanged because no fact changes.
6. A Context Tape write failure inside a terminal transaction rolls back the transcript write with
   it, as it does today; a completed reply is never left hanging.

## Acceptance Criteria

- After any terminal transcript write, `getMessage(id)` deep-equals the `payload.record` of the
  latest effective message fact for that id, except `traceCount`.
- Fork, startup recovery, legacy import and retry-restore leave no transcript row without a
  corresponding effective fact, without a later reconciler pass.
- `ensureSessionTapeReady` on an unchanged Session performs no transcript read and appends nothing.
- A Session whose meta row is absent and whose transcript has rows gets a full backfill exactly once,
  and no transcript row is deleted by that call.
- Deleting the meta row and appending a message fact directly to Tape, then calling
  `ensureSessionTapeReady`, materializes the message into the transcript tables.
- A `sent` live append whose derived key already exists with a different `content` logs one warning
  naming the field; identical payloads log nothing.
- `test/main/session/data`, `test/main/tape`, `test/main/agent/deepchat` and the real-SQLite
  contract suites pass. Manual: new chat, resume, edit, delete, steer, manual compaction, fork and
  legacy import show the same rows in the Inspector and the UI.

## Open Questions

None. Decisions that were open in the preceding analysis (`provider/attempt_completed` exclusion,
compaction shift fact shape, sidecar ownership) are settled above or in `tape-system.md`.
