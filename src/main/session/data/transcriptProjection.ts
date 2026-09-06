import type { ChatMessageRecord, UserMessageContent } from '@shared/types/agent-interface'
import logger from '@shared/logger'
import { getAttachmentSearchableText } from '@shared/utils/attachmentRepresentation'
import {
  buildUsageStatsRecord,
  parseMessageMetadata,
  resolveUsageModelId,
  resolveUsageProviderId
} from '@/session/usageStats'
import type { SessionDatabase } from './database'
import { parseAssistantBlocks, parseUserContent, toUserMessageFileRowInput } from './messageContent'

const MAX_SEARCHABLE_ATTACHMENT_CHARACTERS = 32_000
const SEARCH_ATTACHMENT_TRUNCATION_MARKER = '[Attachment search text truncated]'

/**
 * Writes terminal message state into the transcript tables from a `ChatMessageRecord`. The record
 * is the one carried by the message fact, so live writes and replay from Tape run the same code
 * and cannot leave a table behind. Every write is an UPSERT or a replace keyed by message id;
 * nothing here deletes a row except `applyRetractions`, and nothing here opens a transaction.
 */
export class TranscriptProjectionApplier {
  constructor(private readonly database: SessionDatabase) {}

  applyRecord(record: ChatMessageRecord): void {
    this.database.deepchatMessagesTable.upsert({
      id: record.id,
      sessionId: record.sessionId,
      orderSeq: record.orderSeq,
      role: record.role,
      content: record.content,
      status: record.status,
      isContextEdge: record.isContextEdge,
      metadata: record.metadata,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    })

    if (record.role === 'user') {
      const content = parseUserContent(record.content)
      if (content) {
        this.persistUserContent(record.id, content)
      }
      this.upsertSearchDocument(record)
      return
    }

    this.database.deepchatAssistantBlocksTable.replaceForMessage(
      record.id,
      parseAssistantBlocks(record.content)
    )
    if (record.status !== 'pending') {
      this.upsertSearchDocument(record)
    }
    this.persistUsageStats(record)
  }

  /** Removes every message-scoped row, including the runtime sidecars keyed by message id. */
  applyRetractions(messageIds: string[]): void {
    if (messageIds.length === 0) return
    this.database.deepchatSearchDocumentsTable.deleteByMessageIds(messageIds)
    this.database.deepchatAssistantBlocksTable.deleteByMessageIds(messageIds)
    this.database.deepchatUserMessageLinksTable.deleteByMessageIds(messageIds)
    this.database.deepchatUserMessageFilesTable.deleteByMessageIds(messageIds)
    this.database.deepchatUserMessagesTable.deleteByMessageIds(messageIds)
    this.database.deepchatMessageTracesTable.deleteByMessageIds(messageIds)
    this.database.deepchatMessageSearchResultsTable.deleteByMessageIds(messageIds)
    this.database.deepchatMessagesTable.deleteByIds(messageIds)
  }

  private persistUserContent(messageId: string, content: UserMessageContent): void {
    this.database.deepchatUserMessagesTable.upsert({
      messageId,
      text: content.text,
      searchEnabled: content.search === true,
      thinkEnabled: content.think === true
    })
    this.database.deepchatUserMessageFilesTable.replaceForMessage(
      messageId,
      content.files.map((file) => toUserMessageFileRowInput(file))
    )
    this.database.deepchatUserMessageLinksTable.replaceForMessage(messageId, content.links)
  }

  private upsertSearchDocument(record: ChatMessageRecord): void {
    const sessionTitle = this.database.newSessionsTable.get(record.sessionId)?.title ?? ''
    this.database.deepchatSearchDocumentsTable.upsert({
      documentKey: `message:${record.id}`,
      sessionId: record.sessionId,
      messageId: record.id,
      documentKind: 'message',
      role: record.role,
      title: sessionTitle,
      content: extractSearchableMessageContent(record.content),
      updatedAt: record.updatedAt
    })
  }

  private persistUsageStats(record: ChatMessageRecord): void {
    persistMessageUsageStats(this.database, record)
  }
}

/**
 * Usage stats derive from an assistant message's metadata. The pending region updates them while a
 * reply streams; the applier writes them once more from the terminal record.
 */
export function persistMessageUsageStats(
  database: SessionDatabase,
  record: ChatMessageRecord
): void {
  if (record.role !== 'assistant') return
  try {
    const metadata = parseMessageMetadata(record.metadata)
    if (metadata.messageType === 'compaction') {
      return
    }

    const sessionRow = database.deepchatSessionsTable.get(record.sessionId)
    const providerId = resolveUsageProviderId(metadata, sessionRow?.provider_id)
    const modelId = resolveUsageModelId(metadata, sessionRow?.model_id)
    if (!providerId || !modelId) {
      return
    }

    const usageRecord = buildUsageStatsRecord({
      messageId: record.id,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      providerId,
      modelId,
      metadata,
      source: 'live'
    })
    if (usageRecord) {
      database.deepchatUsageStatsTable.upsert(usageRecord)
    }
  } catch (error) {
    logger.error(
      'Failed to persist deepchat usage stats',
      { messageId: record.id, source: 'live' },
      error
    )
  }
}

export function extractSearchableMessageContent(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as
      | UserMessageContent
      | Array<{
          type?: string
          content?: string
          text?: string
          error?: string
        }>

    if (Array.isArray(parsed)) {
      const segments = parsed
        .flatMap((block) => {
          if (!block || typeof block !== 'object') {
            return []
          }

          const values = [block.content, block.text, block.error]
          return values.filter(
            (value): value is string => typeof value === 'string' && value.trim().length > 0
          )
        })
        .map((value) => value.trim())

      if (segments.length > 0) {
        return segments.join('\n')
      }
    } else if (parsed && typeof parsed === 'object') {
      const segments: string[] = []
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        segments.push(parsed.text.trim())
      }
      const searchableAttachmentText = buildSearchableAttachmentText(parsed.files)
      if (searchableAttachmentText) segments.push(searchableAttachmentText)
      return segments.join('\n')
    }
  } catch {
    // Plain-text fallback.
  }

  return rawContent.trim()
}

function buildSearchableAttachmentText(files: unknown): string {
  if (!Array.isArray(files)) return ''
  const text = files
    .flatMap((file) => {
      const searchableText = getAttachmentSearchableText(file).trim()
      return searchableText ? [searchableText] : []
    })
    .join('\n')
  if (text.length <= MAX_SEARCHABLE_ATTACHMENT_CHARACTERS) return text

  const marker = `\n${SEARCH_ATTACHMENT_TRUNCATION_MARKER}\n`
  const retainedCharacters = Math.max(
    0,
    Math.floor((MAX_SEARCHABLE_ATTACHMENT_CHARACTERS - marker.length) / 2)
  )
  let headEnd = retainedCharacters
  if (isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1
  let tailStart = text.length - retainedCharacters
  if (isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1
  return `${text.slice(0, headEnd).trimEnd()}${marker}${text.slice(tailStart).trimStart()}`
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
