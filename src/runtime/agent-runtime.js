import { createHash, randomUUID } from "node:crypto";
import {
  cdata,
  extractTrailingProse,
  parseAgentResponse,
  serializeProtocolError,
  serializeToolResult,
} from "../protocol/xml-protocol.js";
import {
  appendSystemReminder,
  DEFAULT_SYSTEM_REMINDER,
  NATIVE_IMAGE_SYSTEM_REMINDER,
} from "../protocol/markers.js";
import {
  buildBootstrapPrompt,
  buildResumePrompt,
} from "../protocol/prompt-builder.js";
import {
  assistantMessage,
  functionCall,
  functionCallOutput,
  messageText,
  toolResultOutput,
  userMessage,
} from "../session/canonical-transcript.js";
import { DEFAULT_LIMITS } from "../shared/limits.js";
import { MUSIC_SYSTEM_REMINDER } from "../audio/native-music-receiver.js";
import { utf8ByteLength } from "../shared/text-budget.js";
import {
  BrowserAdapterError,
  ProtocolError,
  ToolValidationError,
} from "../shared/errors.js";
import {
  isConnectionLostError,
  isValidOutboundCorrelationId,
} from "../browser/base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

const EMPTY_ASSISTANT_CONTINUE_MESSAGE =
  "The previous assistant response was empty. Continue the immediately preceding task "
  + "from the existing conversation context. Do not repeat any local tool operation "
  + "whose result is already present. Reply using the required <agent_response> XML protocol.";

const DEAD_REQUEST_CONTINUE_MESSAGE =
  "The previous request received no reply. Continue the immediately preceding task "
  + "from the existing conversation context. Do not repeat any local tool operation "
  + "whose result is already present. Reply using the required <agent_response> XML protocol.";

const GENERATION_FAILED_CONTINUE_MESSAGE =
  "The previous reply was a provider-side generation failure (server error), not an answer. "
  + "Retry the immediately preceding task from the existing conversation context. Do not "
  + "repeat any local tool operation whose result is already present. Reply using the "
  + "required <agent_response> XML protocol.";
const OUTBOUND_CORRELATION_PREFIX =
  " Opaque WTAgent transport correlation ID (do not repeat): ";
const OUTBOUND_CORRELATION_RESERVE_BYTES = utf8ByteLength(
  `${OUTBOUND_CORRELATION_PREFIX}${"0".repeat(36)}.`,
);

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalArgs(args) {
  return JSON.stringify(canonicalize(args));
}

function deriveToolIdentity({
  sessionId,
  assistantMessageId,
  turn,
  toolCall,
  turnNumber,
}) {
  const args = canonicalArgs(toolCall.args);
  const messageIdentity = assistantMessageId
    ? `message:${assistantMessageId}`
    : `turn:${turnNumber}:${createHash("sha256").update(turn.raw).digest("hex")}`;
  const operationKey = createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(messageIdentity)
    .digest("hex");
  const fingerprint = createHash("sha256")
    .update(operationKey)
    .update("\0")
    .update(toolCall.name)
    .update("\0")
    .update(args)
    .digest("hex");
  const requestSignature = createHash("sha256")
    .update(toolCall.name)
    .update("\0")
    .update(args)
    .digest("hex");
  return {
    operationKey,
    callId: `call_${fingerprint.slice(0, 16)}`,
    name: toolCall.name,
    args,
    fingerprint,
    requestSignature,
  };
}

function unknownCompletionResult(toolCall, message = null) {
  return {
    callId: toolCall.id,
    name: toolCall.name,
    ok: false,
    message: message ?? (
      "This tool call may have started, but its completion is unknown. "
      + "It will not be replayed automatically; inspect local state and use "
      + "a deliberate follow-up operation if needed."
    ),
    meta: {
      completionUnknown: true,
      recoverable: true,
    },
  };
}

function deniedResult(toolCall, reasons) {
  return {
    callId: toolCall.id,
    name: toolCall.name,
    ok: false,
    message: `User denied this tool call: ${reasons.join("; ")}`,
  };
}

function policyRejectedResult(toolCall, message) {
  return {
    callId: toolCall.id,
    name: toolCall.name,
    ok: false,
    message: `Tool request rejected before execution: ${message}`,
  };
}

export class AgentRuntime {
  constructor({
    adapter,
    registry,
    policy,
    session,
    approval,
    onEvent,
    postAuthSetup = null,
    nativeImageReceiver = null,
    nativeMusicReceiver = null,
    limits = DEFAULT_LIMITS,
  }) {
    this.adapter = adapter;
    this.registry = registry;
    this.policy = policy;
    this.session = session;
    this.approval = approval;
    this.onEvent = onEvent;
    this.postAuthSetup = postAuthSetup;
    this.nativeImageReceiver = nativeImageReceiver;
    this.nativeMusicReceiver = nativeMusicReceiver;
    this.limits = limits;
    this.conversationIdentityQueue = Promise.resolve();
    this.deferConversationIdentityPersistence = false;
    this.adapter.setConversationIdentityListener?.((identity) =>
      this.#queueConversationIdentity(identity)
    );
  }

  async emit(type, payload = {}) {
    const event = await this.session.appendEvent(type, payload);
    await this.onEvent?.(event);
    return event;
  }

  #assertProviderReadyForMessage() {
    if (this.session.state.pendingAuxiliaryTurn != null) {
      throw new BrowserAdapterError(
        "The provider operation has no verified assistant boundary. No further message was sent.",
        { code: "AUXILIARY_TURN_RECOVERY_REQUIRED", recoverable: false },
      );
    }
    if (this.session.state.pendingOutbound != null) {
      throw new BrowserAdapterError(
        "A previous provider message has not been reconciled. No further message was sent.",
        { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
      );
    }
  }

  async sendMessage(text, {
    files = [],
    maxBytes = null,
    allowFreshReconnect = false,
    allowAssistantContinuation = false,
    requireAttachments = false,
    outboundKind = "runtime_message",
    transcriptItems = [],
    runtimeTurn = null,
    pendingToolAcknowledgement = null,
  } = {}) {
    this.#assertProviderReadyForMessage();
    await this.nativeMusicReceiver?.prepare();
    const outboundId = randomUUID();
    const reminder = this.nativeMusicReceiver ? MUSIC_SYSTEM_REMINDER
      : this.nativeImageReceiver ? NATIVE_IMAGE_SYSTEM_REMINDER : DEFAULT_SYSTEM_REMINDER;
    const message = appendSystemReminder(
      text,
      `${reminder}${OUTBOUND_CORRELATION_PREFIX}${outboundId}.`,
    );
    const pendingOutbound = {
      kind: outboundKind,
      outboundId,
      messageHash: createHash("sha256").update(message).digest("hex"),
      preparedAt: new Date().toISOString(),
      transcriptItems,
      runtimeTurn: Number.isSafeInteger(runtimeTurn) ? runtimeTurn : null,
      pendingToolAcknowledgement,
      conversationUrl: this.session.state.conversationUrl ?? null,
      conversationTargetId: this.session.state.conversationTargetId ?? null,
    };
    await this.#queueSessionUpdate({ pendingOutbound });
    try {
      const sendResult = await this.#sendMessageWithReconnect(message, {
        files,
        maxBytes,
        allowFreshReconnect,
        allowAssistantContinuation,
        requireAttachments,
        outboundId,
      });
      const handoff = await this.#queueSessionOperation(() => (
        this.session.commitPendingOutboundHandoff({
          outboundId,
          handoff: {
            runtimeTurn: pendingOutbound.runtimeTurn
              ?? this.session.state.turn,
            conversationUrl: sendResult?.conversationUrl
              ?? this.session.state.conversationUrl,
            conversationTargetId: sendResult?.conversationTargetId
              ?? this.session.state.conversationTargetId,
            userMessageId: sendResult?.userMessageId ?? null,
            userTurn: sendResult?.userTurn ?? null,
            assistantBaseline: sendResult?.assistantBaseline ?? null,
            preOutboundMarkerIds: sendResult?.preOutboundMarkerIds ?? [],
            pendingToolAcknowledgement,
          },
        })
      ));
      return { ...sendResult, pendingAssistantTurn: handoff };
    } catch (error) {
      const sendStatus = this.adapter.getLastSendStatus?.() ?? "commit-unknown";
      const nextPending = sendStatus === "not-submitted"
        ? null
        : {
          ...pendingOutbound,
          status: "commit-unknown",
          failedAt: new Date().toISOString(),
        };
      await this.#queueSessionOperation(async () => {
        if (this.session.state.pendingOutbound?.outboundId === outboundId) {
          await this.session.update({ pendingOutbound: nextPending });
        }
      }).catch(() => {});
      throw error;
    } finally {
      // URL observation must never replace the send result. Top-frame navigation
      // is persisted eagerly; this is only a best-effort final checkpoint.
      const identity = await this.#syncConversationIdentity({
        suppressErrors: true,
      });
      await this.#refreshPendingOutboundIdentity(outboundId, identity)
        .catch(() => null);
    }
  }

  async #persistConversationIdentity(identity, { allowFresh = false } = {}) {
    const conversationUrl = identity?.conversationUrl ?? null;
    const kind = identity?.kind
      ?? (conversationUrl && this.adapter.classifyConversationUrl?.(conversationUrl));
    if (
      !conversationUrl
      || (
        !["restorable", "provisional"].includes(kind)
        && !(allowFresh && kind === "fresh")
      )
    ) {
      return null;
    }

    const targetId = typeof identity?.targetId === "string"
      && identity.targetId
      ? identity.targetId
      : null;
    const patch = {};
    if (conversationUrl !== this.session.state.conversationUrl) {
      patch.conversationUrl = conversationUrl;
    }
    if (
      targetId
      && targetId !== this.session.state.conversationTargetId
    ) {
      patch.conversationTargetId = targetId;
    }
    if (Object.keys(patch).length > 0) {
      await this.session.update(patch);
    }
    return {
      conversationUrl,
      targetId: targetId ?? this.session.state.conversationTargetId ?? null,
      kind,
    };
  }

  #queueConversationIdentity(identity, options = {}) {
    if (this.deferConversationIdentityPersistence) {
      return Promise.resolve(null);
    }
    const operation = this.conversationIdentityQueue
      .catch(() => null)
      .then(() => this.#persistConversationIdentity(identity, options));
    this.conversationIdentityQueue = operation;
    return operation;
  }

  #queueSessionOperation(callback) {
    const operation = this.conversationIdentityQueue
      .catch(() => null)
      .then(callback);
    this.conversationIdentityQueue = operation;
    return operation;
  }

  #queueSessionUpdate(patch) {
    return this.#queueSessionOperation(() => this.session.update(patch));
  }

  async #refreshPendingOutboundIdentity(
    outboundId,
    identity = null,
    { required = false } = {},
  ) {
    return await this.#queueSessionOperation(async () => {
      const current = this.session.state.pendingOutbound;
      if (!current || current.outboundId !== outboundId) {
        if (required) {
          throw new BrowserAdapterError(
            "The pending outbound changed before its reconnect target could be checkpointed.",
            { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
          );
        }
        return null;
      }
      const conversationUrl = identity?.conversationUrl
        ?? this.session.state.conversationUrl
        ?? current.conversationUrl
        ?? null;
      const conversationTargetId = identity?.targetId
        ?? identity?.conversationTargetId
        ?? this.session.state.conversationTargetId
        ?? current.conversationTargetId
        ?? null;
      if (
        conversationUrl === current.conversationUrl
        && conversationTargetId === current.conversationTargetId
      ) {
        return structuredClone(current);
      }
      const refreshed = {
        ...current,
        conversationUrl,
        conversationTargetId,
      };
      await this.session.update({
        pendingOutbound: refreshed,
        conversationUrl,
        conversationTargetId,
      });
      return structuredClone(refreshed);
    });
  }

  async #syncConversationIdentity({
    suppressErrors = false,
    allowFresh = false,
    identity = null,
  } = {}) {
    // Observe and persist inside one queue entry. If a navigation callback fires
    // while observation awaits the adapter, it queues after this operation and
    // remains authoritative instead of being overwritten by a stale snapshot.
    const operation = this.conversationIdentityQueue
      .catch(() => null)
      .then(async () => {
        let observed = identity;
        if (!observed) {
          if (typeof this.adapter.getConversationIdentity === "function") {
            observed = await this.adapter.getConversationIdentity();
          } else {
            const conversationUrl = await this.adapter.getConversationUrl();
            observed = {
              conversationUrl,
              targetId: null,
              kind: this.adapter.classifyConversationUrl?.(conversationUrl)
                ?? (/\/c\//.test(new URL(conversationUrl).pathname)
                  ? "restorable"
                  : "fresh"),
            };
          }
        }
        return await this.#persistConversationIdentity(observed, { allowFresh });
      });
    this.conversationIdentityQueue = operation;
    try {
      return await operation;
    } catch (error) {
      if (!suppressErrors) {
        throw error;
      }
      return null;
    }
  }

  // Retry only when the adapter proves submission never started. Once the Send
  // action has occurred, a dead transport or missing bubble is commit-unknown;
  // replaying the payload could duplicate provider work and attachments.
  async #sendMessageWithReconnect(message, {
    files,
    maxBytes,
    allowFreshReconnect,
    allowAssistantContinuation,
    requireAttachments,
    outboundId,
  }) {
    try {
      return await this.adapter.sendMessage(message, {
        files,
        maxBytes,
        outboundId,
        allowAssistantContinuation,
        requireAttachments,
      });
    } catch (error) {
      if (isConnectionLostError(error)) {
        const sendStatus = this.adapter.getLastSendStatus?.() ?? "commit-unknown";
        if (sendStatus !== "not-submitted") {
          throw new BrowserAdapterError(
            `${this.adapter.providerName ?? "Web provider"} connection was lost after submission may have started. `
              + "The message was not sent again automatically.",
            {
              code: "SEND_COMMIT_UNKNOWN",
              recoverable: false,
              cause: error,
            },
          );
        }
        await this.#reconnectAndRestore({
          allowFresh: allowFreshReconnect,
          checkpointIdentity: (restoration) => (
            this.#refreshPendingOutboundIdentity(
              outboundId,
              restoration,
              { required: true },
            )
          ),
        });
        await this.nativeMusicReceiver?.prepare();
        return await this.adapter.sendMessage(message, {
          files,
          maxBytes,
          outboundId,
          allowAssistantContinuation,
          requireAttachments,
        });
      }
      throw error;
    }
  }

  // Reconnects to the still-alive Chrome and restores the exact page target when
  // possible. Once a context-dependent message has been sent, landing on a fresh
  // page is never a safe restoration.
  async #reconnectAndRestore({
    allowFresh = false,
    checkpointIdentity = null,
  } = {}) {
    // Navigation callbacks must not persist a replacement root target without
    // the pending record that causally owns it. Suppress them until the caller's
    // checkpoint writes both identities in one Session transition.
    this.deferConversationIdentityPersistence = true;
    try {
      await this.conversationIdentityQueue.catch(() => null);
      await this.adapter.reconnect?.(
        this.session.state.conversationUrl,
        { preferredTargetId: this.session.state.conversationTargetId ?? null },
      );
      const restoration = await this.adapter.startConversation(
        this.session.state.conversationUrl,
        {
          expectedAssistantMessageId: this.session.state.lastAssistantMessageId
            ?? null,
          expectedUserMessageId: this.session.state.lastUserMessageId ?? null,
        },
      );
      if (
        restoration?.status !== "restored-existing"
        && !(allowFresh && restoration?.status === "verified-fresh")
      ) {
        throw new BrowserAdapterError(
          `${this.adapter.providerName} conversation disappeared while a turn was in progress. `
            + "Refusing to continue on a blank page; resume the session to recover safely.",
          {
            code: "CONVERSATION_RESTORE_REQUIRED",
            recoverable: false,
            details: { restorationStatus: restoration?.status ?? null },
          },
        );
      }
      const checkpoint = checkpointIdentity
        ? await checkpointIdentity(restoration)
        : null;
      return { restoration, checkpoint };
    } finally {
      this.deferConversationIdentityPersistence = false;
    }
  }

  async #freshRebuildBlockers({ instruction = null } = {}) {
    const state = this.session.state;
    const blockers = [];
    if (state.pendingOutbound != null) {
      blockers.push("unconfirmed outbound message");
    }
    if (state.pendingAssistantTurn != null) {
      blockers.push("pending assistant handoff");
    }
    if (state.pendingAuxiliaryTurn != null) {
      blockers.push("pending auxiliary provider turn");
    }
    if (state.pendingToolResult != null) {
      blockers.push("pending tool result");
    }
    if (Object.keys(state.completedTools ?? {}).length > 0) {
      blockers.push("completed tool history");
    }
    if (Object.keys(state.sideEffectTools ?? {}).length > 0) {
      blockers.push("side-effect history");
    }
    if (state.lastMessage != null) {
      blockers.push("completed assistant result");
    }
    if (
      state.lastAssistantMessageId != null
      || await this.session.hasEvent("model.message_complete")
    ) {
      blockers.push("completed or ambiguous assistant response");
    }

    const suppliedInstruction = instruction?.trim() ?? "";
    const followUps = state.followUps ?? [];
    const persistedInstructions = [
      ...new Set(followUps.map((item) => item?.instruction?.trim()).filter(Boolean)),
    ];
    const followUpsHaveAttachments = followUps.some((item) =>
      item?.attachments != null
      && (!Array.isArray(item.attachments) || item.attachments.length > 0)
    );
    if (
      followUpsHaveAttachments
      || persistedInstructions.length > 1
      || (
        suppliedInstruction
        && persistedInstructions.length === 1
        && persistedInstructions[0] !== suppliedInstruction
      )
    ) {
      blockers.push("earlier follow-up history");
    }
    const rebuildInstruction = suppliedInstruction
      || (persistedInstructions.length === 1 ? persistedInstructions[0] : null);

    const transcript = await this.session.readTranscript();
    if (transcript.items.length !== 1) {
      blockers.push(
        transcript.items.length === 0
          ? "missing opening transcript"
          : "canonical transcript history",
      );
    } else {
      const item = transcript.items[0].item;
      const hasNoAttachments = item?.attachments == null
        || (Array.isArray(item.attachments) && item.attachments.length === 0);
      const isOriginalUser = item?.type === "message"
        && item.role === "user"
        && messageText(item) === String(state.task ?? "")
        && hasNoAttachments;
      if (!isOriginalUser) {
        blockers.push("canonical transcript history");
      }
    }
    return { blockers, transcript, rebuildInstruction };
  }

  buildToolResultMessage(result, { suffix = "" } = {}) {
    const limit = this.limits.maxBrowserToolResultBytes;
    const nonResultBytes = utf8ByteLength(appendSystemReminder(suffix,
      this.nativeImageReceiver ? NATIVE_IMAGE_SYSTEM_REMINDER : DEFAULT_SYSTEM_REMINDER))
      + OUTBOUND_CORRELATION_RESERVE_BYTES;
    const resultBudget = limit - nonResultBytes;
    if (resultBudget < 512) {
      throw new RangeError(
        `Tool result metadata leaves fewer than 512 bytes within the ${limit}-byte browser limit.`,
      );
    }
    return `${serializeToolResult(result, { maxBytes: resultBudget })}${suffix}`;
  }

  async sendToolResult(result, {
    suffix = "",
    runtimeTurn = null,
  } = {}) {
    return await this.sendMessage(
      this.buildToolResultMessage(result, { suffix }),
      {
        maxBytes: this.limits.maxBrowserToolResultBytes,
        outboundKind: "tool_result",
        runtimeTurn,
        pendingToolAcknowledgement: {
          callId: result.callId ?? null,
          name: result.name ?? null,
          operationSignature: result.operationSignature ?? null,
        },
      },
    );
  }

  // Runs a provider-native helper turn (currently used by image.generate) in
  // the same web conversation without exposing that turn as another WTAgent
  // protocol exchange. The send still goes through the adapter's full causal
  // checks, and both provider message identities are checkpointed before the
  // caller is allowed to send the tool result.
  async runAuxiliaryTurn({
    text,
    files = [],
    timeoutMs = this.limits.modelTurnTimeoutMs,
    waitForCompletion,
  }) {
    if (typeof waitForCompletion !== "function") {
      throw new TypeError("An auxiliary turn requires a completion callback.");
    }
    this.#assertProviderReadyForMessage();
    const outboundId = randomUUID();
    const message = appendSystemReminder(
      text,
      `This is an internal WTAgent provider operation. Perform only the requested operation; do not emit the WTAgent XML protocol.${OUTBOUND_CORRELATION_PREFIX}${outboundId}.`,
    );
    const pendingOutbound = {
      kind: "auxiliary_tool_turn",
      outboundId,
      messageHash: createHash("sha256").update(message).digest("hex"),
      preparedAt: new Date().toISOString(),
      transcriptItems: [],
      runtimeTurn: null,
      pendingToolAcknowledgement: null,
      conversationUrl: this.session.state.conversationUrl ?? null,
      conversationTargetId: this.session.state.conversationTargetId ?? null,
    };
    await this.#queueSessionUpdate({ pendingOutbound });

    let sendResult;
    try {
      sendResult = await this.#sendMessageWithReconnect(message, {
        files,
        maxBytes: null,
        allowFreshReconnect: false,
        allowAssistantContinuation: false,
        requireAttachments: files.length > 0,
        outboundId,
      });
      await this.#queueSessionOperation(() => (
        this.session.commitPendingAuxiliaryTurn({
          outboundId,
          turn: {
            conversationUrl: sendResult?.conversationUrl
              ?? this.session.state.conversationUrl,
            conversationTargetId: sendResult?.conversationTargetId
              ?? this.session.state.conversationTargetId,
            userMessageId: sendResult?.userMessageId ?? null,
            userTurn: sendResult?.userTurn ?? null,
            assistantBaseline: sendResult?.assistantBaseline ?? null,
          },
        })
      ));
    } catch (error) {
      const sendStatus = this.adapter.getLastSendStatus?.() ?? "commit-unknown";
      await this.#queueSessionOperation(async () => {
        if (this.session.state.pendingOutbound?.outboundId === outboundId) {
          await this.session.update({
            pendingOutbound: sendStatus === "not-submitted"
              ? null
              : {
                ...pendingOutbound,
                status: "commit-unknown",
                failedAt: new Date().toISOString(),
              },
          });
        }
      }).catch(() => {});
      if (sendStatus !== "not-submitted") {
        error.completionUnknown = true;
      }
      throw error;
    } finally {
      await this.#syncConversationIdentity({ suppressErrors: true });
    }

    let value;
    try {
      value = await waitForCompletion({
        adapter: this.adapter,
        page: this.adapter.page,
        sendResult,
        timeoutMs,
      });
      const completion = await this.adapter.captureAuxiliaryTurnCompletion?.({
        timeoutMs: Math.min(timeoutMs, 30_000),
      })
        ?? null;
      const assistantMessageId = completion?.assistantMessageId
        ?? await this.adapter.getLastAssistantMessageId?.()
        ?? null;
      const assistantTurn = completion?.assistantTurn
        ?? await this.adapter.getLastAssistantTurn?.()
        ?? null;
      await this.#queueSessionOperation(() => (
        this.session.completePendingAuxiliaryTurn({
          outboundId,
          assistantMessageId,
          assistantTurn,
        })
      ));
      return value;
    } catch (error) {
      // A provider can finish the visible assistant turn yet fail while WTAgent
      // downloads or validates its artifact. Close that browser-turn checkpoint
      // when its final boundary is still provable; otherwise retain it so a
      // later resume cannot blindly submit a duplicate image request.
      try {
        const completion = await this.adapter.captureAuxiliaryTurnCompletion?.({
          timeoutMs: Math.min(timeoutMs, 5_000),
        });
        if (completion) {
          await this.#queueSessionOperation(() => (
            this.session.completePendingAuxiliaryTurn({
              outboundId,
              assistantMessageId: completion.assistantMessageId ?? null,
              assistantTurn: completion.assistantTurn ?? null,
            })
          ));
        }
      } catch {
        // Keep pendingAuxiliaryTurn intact when completion cannot be proven.
      }
      // If the completion callback produced a temporary artifact but the
      // assistant-boundary checkpoint failed, ownership never reaches the
      // ImageGenerationService, so clean it here.
      await value?.cleanup?.().catch(() => null);
      error.completionUnknown = true;
      throw error;
    } finally {
      await this.#syncConversationIdentity({ suppressErrors: true });
    }
  }

  async #appendHandoffTranscript(activeHandoff, suffix, item) {
    if (!activeHandoff?.handoffId) {
      throw new Error("Cannot append transcript without an assistant handoff ID.");
    }
    return await this.session.appendTranscriptItemOnce(item, {
      idempotencyKey: `${activeHandoff.handoffId}:${suffix}`,
    });
  }

  #inferPendingRuntimeTurn(pendingOutbound) {
    if (Number.isSafeInteger(pendingOutbound?.runtimeTurn)) {
      return pendingOutbound.runtimeTurn;
    }
    const currentTurn = Number(this.session.state.turn || 0);
    if ([
      "empty_response_recovery",
      "dead_request_recovery",
      "generation_failed_recovery",
    ].includes(pendingOutbound?.kind)) {
      return Math.max(1, currentTurn);
    }
    return currentTurn + 1;
  }

  #recoveryHandoffPatch(outcome) {
    return {
      conversationUrl: outcome.conversationUrl,
      conversationTargetId: outcome.conversationTargetId,
      userMessageId: outcome.userMessageId,
      userTurn: outcome.userTurn,
      preOutboundMarkerIds: outcome.preOutboundMarkerIds ?? [],
      assistantBaseline: outcome.assistantBaseline ?? null,
      assistantCandidateMessageId:
        outcome.assistantCandidateMessageId ?? null,
      assistantCandidateTurn: outcome.assistantCandidateTurn ?? null,
    };
  }

  async #refreshHandoffAfterRestore(handoff, restoration) {
    const conversationUrl = restoration?.conversationUrl
      ?? this.session.state.conversationUrl
      ?? handoff.conversationUrl;
    const conversationTargetId = restoration?.targetId
      ?? this.session.state.conversationTargetId
      ?? handoff.conversationTargetId;
    const refreshed = await this.#queueSessionOperation(() => (
      this.session.refreshPendingAssistantTurn(handoff.handoffId, {
        conversationUrl,
        conversationTargetId,
      })
    ));
    this.adapter.acceptRecoveredOutboundAnchor?.({
      conversationUrl,
      conversationTargetId,
      userMessageId: refreshed.userMessageId,
      userTurn: refreshed.userTurn,
      assistantBaseline: refreshed.assistantBaseline,
      assistantCandidateMessageId:
        refreshed.assistantCandidateMessageId ?? null,
      assistantCandidateTurn: refreshed.assistantCandidateTurn ?? null,
    });
    return refreshed;
  }

  async #recoverPendingConversation({ pendingOutbound, pendingAssistantTurn }) {
    const outboundId = pendingOutbound?.outboundId
      ?? pendingAssistantTurn?.sourceOutboundId
      ?? null;
    if (!isValidOutboundCorrelationId(outboundId)) {
      throw new BrowserAdapterError(
        "The pending browser handoff has no valid outbound correlation ID.",
        { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
      );
    }
    if (!this.adapter.supportsPendingOutboundRecovery?.()) {
      throw new BrowserAdapterError(
        `${this.adapter.providerName ?? "Web provider"} does not support safe pending outbound recovery.`,
        { code: "OUTBOUND_RECOVERY_UNSUPPORTED", recoverable: false },
      );
    }
    const boundTargetId = pendingOutbound?.conversationTargetId
      ?? (!pendingOutbound
        ? pendingAssistantTurn?.conversationTargetId ?? null
        : null);
    const rootTargetId = this.session.state.conversationTargetId ?? null;
    if (
      boundTargetId
      && rootTargetId
      && boundTargetId !== rootTargetId
    ) {
      throw new BrowserAdapterError(
        "The pending browser handoff target conflicts with the Session target. Refusing to choose either target.",
        { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
      );
    }
    const targetId = boundTargetId ?? rootTargetId;
    if (!targetId) {
      throw new BrowserAdapterError(
        "Pending outbound recovery requires the exact saved browser target.",
        { code: "RECOVERY_TARGET_UNAVAILABLE", recoverable: false },
      );
    }

    await this.adapter.launchRecoveryTarget(targetId);
    await this.emit("browser.started", {
      profileDir: this.adapter.profileDir,
      recovery: true,
      targetId,
    });
    const priorForReconciliation = pendingOutbound
      && pendingAssistantTurn?.sourceOutboundId !== pendingOutbound.outboundId
      ? null
      : pendingAssistantTurn;
    const outcome = await this.adapter.reconcilePendingOutbound({
      pendingOutbound,
      priorHandoff: priorForReconciliation,
      conversationTargetId: targetId,
      lastUserMessageId: this.session.state.lastUserMessageId ?? null,
      lastAssistantMessageId:
        this.session.state.lastAssistantMessageId ?? null,
    });
    if (!["waiting", "complete"].includes(outcome?.status)) {
      throw new BrowserAdapterError(
        "Pending outbound recovery did not return a durable assistant boundary.",
        { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
      );
    }
    const outcomeKind = outcome.conversationUrl
      ? this.adapter.classifyConversationUrl?.(outcome.conversationUrl)
      : null;
    if (
      outcome.conversationTargetId !== targetId
      || !["restorable", "provisional"].includes(outcomeKind)
    ) {
      throw new BrowserAdapterError(
        "Pending outbound recovery returned a different browser target or conversation route.",
        { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
      );
    }

    let handoff = pendingAssistantTurn;
    if (pendingOutbound) {
      const pendingToolAcknowledgement =
        pendingOutbound.pendingToolAcknowledgement
        ?? (["tool_result", "pending_tool_result"].includes(pendingOutbound.kind)
          && this.session.state.pendingToolResult
          ? {
            callId: this.session.state.pendingToolResult.callId ?? null,
            name: this.session.state.pendingToolResult.name ?? null,
            operationSignature:
              this.session.state.pendingToolResult.operationSignature ?? null,
          }
          : null);
      handoff = await this.#queueSessionOperation(() => (
        this.session.commitPendingOutboundHandoff({
          outboundId: pendingOutbound.outboundId,
          handoff: {
            ...this.#recoveryHandoffPatch(outcome),
            runtimeTurn: this.#inferPendingRuntimeTurn(pendingOutbound),
            pendingToolAcknowledgement,
          },
        })
      ));
      await this.emit("outbound.reconciled", {
        outboundId: pendingOutbound.outboundId,
        kind: pendingOutbound.kind ?? null,
        status: outcome.status,
        userMessageId: outcome.userMessageId ?? null,
      });
    } else if (handoff) {
      handoff = await this.#queueSessionOperation(() => (
        this.session.refreshPendingAssistantTurn(
          handoff.handoffId,
          this.#recoveryHandoffPatch(outcome),
        )
      ));
    }

    // Recovery reconciles text/identity. A not-yet-checkpointed native turn
    // still needs the ordinary image-aware completion reader before sealing it.
    if (outcome.status === "complete" && ((!this.nativeImageReceiver && !this.nativeMusicReceiver) || handoff.status === "complete")) {
      const outcomeHash = createHash("sha256")
        .update(outcome.rawResponse)
        .digest("hex");
      if (outcome.responseHash && outcome.responseHash !== outcomeHash) {
        throw new BrowserAdapterError(
          "Recovered assistant response hash does not match its raw content.",
          { code: "OUTBOUND_COMMIT_UNCERTAIN", recoverable: false },
        );
      }
      handoff = await this.#queueSessionOperation(() => (
        this.session.completePendingAssistantTurn({
          handoffId: handoff.handoffId,
          assistantMessageId: outcome.assistantMessageId ?? null,
          assistantTurn: outcome.assistantTurn ?? null,
          rawResponse: outcome.rawResponse,
          nativeImages: handoff.nativeImages ?? [],
          nativeMusic: handoff.nativeMusic ?? [],
        })
      ));
    }
    return handoff;
  }

  async run({
    resume = false,
    instruction = null,
    files = [],
    inPlaceRecovery = false,
  } = {}) {
    const {
      task,
      projectRoot,
    } = this.session.state;
    const previousConversationUrl = this.session.state.conversationUrl;
    const pendingOutboundAtStart = this.session.state.pendingOutbound;
    const pendingAssistantAtStart = this.session.state.pendingAssistantTurn;
    const pendingAuxiliaryAtStart = this.session.state.pendingAuxiliaryTurn;
    if (pendingAuxiliaryAtStart != null) {
      throw new BrowserAdapterError(
        "An image/provider auxiliary turn was interrupted after submission. "
          + "WTAgent will not replay it automatically because that could create a duplicate remote artifact.",
        { code: "AUXILIARY_TURN_RECOVERY_REQUIRED", recoverable: false },
      );
    }
    const hasPendingRecovery = pendingOutboundAtStart != null
      || pendingAssistantAtStart != null;
    if (this.nativeMusicReceiver && resume && !hasPendingRecovery
        && !instruction?.trim() && files.length === 0 && this.session.state.lastMusicResult) {
      // Bare resume of a completed generation must not spend quota again.
      const result = this.session.state.lastMusicResult;
      await this.emit("run.completed", result);
      return { sessionId: this.session.sessionId, ...result };
    }
    const supportsStrictRecovery = Boolean(
      this.adapter.supportsPendingOutboundRecovery?.(),
    );
    const strictRecoveryAtStart = pendingOutboundAtStart != null
      || (pendingAssistantAtStart != null && supportsStrictRecovery);
    const legacyAssistantRecoveryAtStart = pendingOutboundAtStart == null
      && pendingAssistantAtStart != null
      && !supportsStrictRecovery;
    if (
      hasPendingRecovery
      && (
        !resume
        || Boolean(instruction?.trim())
        || (files ?? []).length > 0
      )
    ) {
      throw new BrowserAdapterError(
        "A pending browser handoff can only be recovered with a bare resume. "
          + "Do not add an instruction or attachment until recovery completes.",
        { code: "RECOVERY_REQUIRES_BARE_RESUME", recoverable: false },
      );
    }
    const attachments = (files ?? []).map((file) => ({
      name: file.name ?? null,
      path: file.path ?? null,
    }));
    const messageOptions = attachments.length > 0 ? { attachments } : {};

    // Persist the opening user intent (including attachment metadata) before any
    // browser work. A later recovery can then distinguish a replayable untouched
    // task from an unknowable empty legacy rollout.
    if (!resume) {
      const transcript = await this.session.readTranscript();
      if (transcript.items.length === 0) {
        await this.session.appendTranscriptItemOnce(
          userMessage(task, messageOptions),
          { idempotencyKey: `session:${this.session.sessionId}:opening` },
        );
      }
    }

    await this.session.update({
      phase: "initializing",
      runCount: Number(this.session.state.runCount || 0) + 1,
      lastError: null,
    });
    await this.emit("runtime.initializing");

    const modelTurnTimeoutMs = this.limits.modelTurnTimeoutMs;
    let pendingToolResult;
    let awaitingPendingAcknowledgement = false;
    let replayGuard = null;
    let protocolErrors = 0;
    const baseTurn = resume ? Number(this.session.state.turn || 0) : 0;

    if (strictRecoveryAtStart) {
      const recoveredHandoff = await this.#recoverPendingConversation({
        pendingOutbound: pendingOutboundAtStart,
        pendingAssistantTurn: pendingAssistantAtStart,
      });
      // Recovery proves the browser boundary before touching a possibly-running
      // side-effect ledger. The existing local exactly-once rules then apply.
      await this.session.recoverInterruptedSideEffects();
      pendingToolResult = this.session.state.pendingToolResult;
      awaitingPendingAcknowledgement = Boolean(
        recoveredHandoff.pendingToolAcknowledgement,
      );
      replayGuard = pendingToolResult?.operationSignature
        ? {
          signature: pendingToolResult.operationSignature,
          result: pendingToolResult,
        }
        : null;
      await this.session.update({
        phase: "running",
        activeMode: null,
      });
      await this.emit("conversation.started", {
        url: recoveredHandoff.conversationUrl,
        recovered: true,
      });
    } else {
    // On resume, prefer an existing tab already showing the conversation so
    // repeated resumes reuse the same tab instead of piling up new ones.
    await this.adapter.launch(
      resume ? this.session.state.conversationUrl : null,
      {
        preferredTargetId: resume
          ? this.session.state.conversationTargetId ?? null
          : null,
      },
    );
    await this.emit("browser.started", {
      profileDir: this.adapter.profileDir,
    });

    let authState = await this.adapter.getAuthState();
    if (authState !== "authenticated") {
      try {
        await this.adapter.waitForManualLogin({ timeoutMs: 8_000 });
        authState = "authenticated";
      } catch {
        // A signed-in ChatGPT page can briefly render its guest shell. Only
        // prompt the user after a short grace period fails.
      }
    }
    if (authState !== "authenticated") {
      await this.session.update({ phase: "auth_required" });
      await this.emit("browser.auth_required");
      // The window may be minimized; bring it forward so the user can log in,
      // then send it back once login is detected.
      await this.adapter.restoreWindow?.();
      try {
        await this.adapter.waitForManualLogin({
          timeoutMs: this.limits.loginTimeoutMs,
        });
      } finally {
        await this.adapter.minimizeWindow?.();
      }
      await this.emit("browser.authenticated");
    }

    let restoration = await this.adapter.startConversation(
      resume ? previousConversationUrl : null,
      {
        expectedAssistantMessageId: resume
          ? this.session.state.lastAssistantMessageId
          : null,
        expectedUserMessageId: resume
          ? this.session.state.lastUserMessageId
          : null,
      },
    );
    if (
      restoration?.status !== "restored-existing"
      && restoration?.status !== "verified-fresh"
    ) {
      throw new BrowserAdapterError(
        `${this.adapter.providerName} did not report whether conversation history was restored.`,
        {
          code: "CONVERSATION_RESTORE_UNVERIFIED",
          recoverable: false,
        },
      );
    }
    if (
      legacyAssistantRecoveryAtStart
      && restoration.status !== "restored-existing"
    ) {
      throw new BrowserAdapterError(
        `${this.adapter.providerName} could not restore the confirmed pending assistant turn. `
          + "Refusing to continue it on a blank conversation.",
        {
          code: "CONVERSATION_RESTORE_REQUIRED",
          recoverable: false,
        },
      );
    }
    await this.#syncConversationIdentity({
      identity: {
        conversationUrl: restoration.conversationUrl,
        targetId: restoration.targetId ?? null,
        kind: restoration.status === "verified-fresh"
          ? "fresh"
          : this.adapter.classifyConversationUrl?.(restoration.conversationUrl),
      },
      allowFresh: restoration.status === "verified-fresh",
    });

    const resumedExistingConversation = resume
      && restoration.status === "restored-existing";
    const rebuildingFreshConversation = resume
      && restoration.status === "verified-fresh";
    let effectiveInstruction = instruction;
    if (rebuildingFreshConversation) {
      const {
        blockers,
        rebuildInstruction,
      } = await this.#freshRebuildBlockers({ instruction });
      if (blockers.length > 0) {
        throw new BrowserAdapterError(
          `${this.adapter.providerName} opened an empty conversation, but this session has `
            + `history that cannot be replayed safely (${blockers.join(", ")}). `
            + "The browser message was not sent.",
          {
            code: "CONVERSATION_REBUILD_UNSAFE",
            recoverable: false,
            details: { blockers },
          },
        );
      }
      effectiveInstruction = rebuildInstruction;
      await this.emit("conversation.rebuilding_fresh", {
        previousUrl: previousConversationUrl,
        url: restoration.conversationUrl,
      });
    }

    // Only normalize an interrupted side-effect ledger after the browser
    // restoration decision. An unsafe fresh-page fallback must leave every
    // pending/result/side-effect record untouched for deliberate inspection.
    await this.session.recoverInterruptedSideEffects();
    pendingToolResult = this.session.state.pendingToolResult;

    // Optional setup after authentication and the target conversation are
    // ready, but before the first message is sent. Interactive CLI runs use
    // this to let the user choose a model directly on the provider website.
    // WTAgent never names, selects, or overrides a provider-specific model.
    // Existing conversations keep their model context. A verified fresh rebuild
    // is a genuinely new web chat, so interactive runs offer the same browser-side
    // model choice as an ordinary bootstrap.
    if (restoration.status === "verified-fresh" && this.postAuthSetup) {
      await this.postAuthSetup({ adapter: this.adapter });
      // Browser-side setup is user-controlled and can navigate the tab. Reopen
      // and re-verify an empty chat after it returns so the bootstrap can never
      // land in a history conversation selected during setup.
      restoration = await this.adapter.startConversation();
      if (restoration?.status !== "verified-fresh") {
        throw new BrowserAdapterError(
          `${this.adapter.providerName} did not remain on a verified empty conversation after browser setup.`,
          {
            code: "CONVERSATION_NOT_FRESH",
            recoverable: false,
          },
        );
      }
      await this.#syncConversationIdentity({
        identity: {
          conversationUrl: restoration.conversationUrl,
          targetId: restoration.targetId ?? null,
          kind: "fresh",
        },
        allowFresh: true,
      });
    }

    await this.session.update({
      phase: "running",
      activeMode: null,
    });
    await this.emit("conversation.started", {
      url: this.session.state.conversationUrl,
    });

    if (legacyAssistantRecoveryAtStart) {
      const recoveredHandoff = await this.#refreshHandoffAfterRestore(
        pendingAssistantAtStart,
        restoration,
      );
      awaitingPendingAcknowledgement = Boolean(
        recoveredHandoff.pendingToolAcknowledgement,
      );
      replayGuard = pendingToolResult?.operationSignature
        ? {
          signature: pendingToolResult.operationSignature,
          result: pendingToolResult,
        }
        : null;
    }
    let initialMessage;
    let initialKind;
    // The web transport gets `.web` (XML/marked text). The portable rollout
    // records only confirmed user messages; WTAgent scaffolding stays transport-only.
    let initialTranscript = [];
    if (!legacyAssistantRecoveryAtStart) {
    if (this.nativeMusicReceiver) {
      if (inPlaceRecovery) throw new Error("Music generation is not automatically repeated; resume the pending turn without a new instruction.");
      const request = effectiveInstruction?.trim() || task;
      initialMessage = `Create the following music using the native Music tool.\n\n${request}`;
      initialTranscript = resume && effectiveInstruction?.trim() ? [userMessage(effectiveInstruction.trim(), messageOptions)] : [];
      initialKind = resume ? "music_follow_up" : "music_generation";
    } else if (resumedExistingConversation && pendingToolResult && !inPlaceRecovery) {
      let suffix = "";
      if (instruction?.trim()) {
        suffix = `\n<resume_instruction>${cdata(instruction)}</resume_instruction>`;
        initialTranscript = [userMessage(instruction, messageOptions)];
      }
      initialMessage = this.buildToolResultMessage(pendingToolResult, { suffix });
      initialKind = "pending_tool_result";
    } else if (resumedExistingConversation && instruction?.trim()) {
      // The live web conversation already contains the bootstrap protocol
      // and tool catalog. A normal follow-up should be the user's message, not
      // another several-thousand-character protocol bootstrap. sendMessage()
      // still appends the short format reminder.
      initialMessage = instruction.trim();
      initialTranscript = [userMessage(instruction.trim(), messageOptions)];
      initialKind = "follow_up";
    } else if (resumedExistingConversation && inPlaceRecovery) {
      // The original request/tool result is already visible in this live web
      // conversation. Ask the provider to continue without duplicating transport
      // payloads, attachments, or canonical transcript entries.
      initialMessage = EMPTY_ASSISTANT_CONTINUE_MESSAGE;
      initialKind = "empty_response_recovery";
    } else if (resume) {
      const prompt = buildResumePrompt({
        instruction: rebuildingFreshConversation
          ? effectiveInstruction
          : instruction,
        state: this.session.state,
        tools: this.registry.list(),
        nativeImages: Boolean(this.nativeImageReceiver),
      });
      initialMessage = prompt.web;
      // The original task is already the one safe canonical item required by the
      // rebuild gate. Record only a newly confirmed follow-up instruction.
      initialTranscript = rebuildingFreshConversation
        ? (effectiveInstruction?.trim()
          ? [userMessage(effectiveInstruction.trim(), messageOptions)]
          : [])
        : [userMessage(prompt.user, messageOptions)];
      initialKind = rebuildingFreshConversation ? "fresh_rebuild" : "resume";
    } else {
      const prompt = buildBootstrapPrompt({
        task,
        projectRoot,
        tools: this.registry.list(),
        nativeImages: Boolean(this.nativeImageReceiver),
      });
      initialMessage = prompt.web;
      // The opening item was persisted before browser setup above.
      initialTranscript = [];
      initialKind = "bootstrap";
    }
    }

    if (!legacyAssistantRecoveryAtStart) {
      await this.sendMessage(initialMessage, {
        files,
        maxBytes: initialKind === "pending_tool_result"
          ? this.limits.maxBrowserToolResultBytes
          : null,
        // A full bootstrap/rebuild prompt may reconnect only when submission was
        // proven not to have started. Context-dependent messages never opt in.
        allowFreshReconnect: restoration.status === "verified-fresh",
        allowAssistantContinuation: initialKind === "empty_response_recovery",
        outboundKind: initialKind,
        transcriptItems: initialTranscript,
        runtimeTurn: baseTurn + 1,
        pendingToolAcknowledgement: pendingToolResult
          ? {
            callId: pendingToolResult.callId ?? null,
            name: pendingToolResult.name ?? null,
            operationSignature: pendingToolResult.operationSignature ?? null,
          }
          : null,
      });
      awaitingPendingAcknowledgement = Boolean(pendingToolResult);
      replayGuard = pendingToolResult?.operationSignature
        ? {
          signature: pendingToolResult.operationSignature,
          result: pendingToolResult,
        }
        : null;
      await this.emit("model.message_sent", { kind: initialKind });
    }
    }

    for (let step = 1; ; step += 1) {
      let activeHandoff = this.session.state.pendingAssistantTurn;
      if (!activeHandoff) {
        throw new BrowserAdapterError(
          "The durable assistant handoff disappeared before response processing.",
          { code: "ASSISTANT_HANDOFF_MISSING", recoverable: false },
        );
      }
      const turnNumber = Number.isSafeInteger(activeHandoff.runtimeTurn)
        ? activeHandoff.runtimeTurn
        : baseTurn + step;
      await this.session.update({ turn: turnNumber, phase: "waiting_model" });
      let raw;
      let nativeImages = [];
      let nativeMusic = [];
      let emptyAssistantRetries = 0;
      let connectionRetries = 0;
      for (;;) {
        try {
          if (activeHandoff.status === "complete") {
            raw = activeHandoff.rawResponse;
            nativeImages = activeHandoff.nativeImages ?? [];
            nativeMusic = activeHandoff.nativeMusic ?? [];
          } else {
            try {
              raw = await this.adapter.waitForTurnComplete({
                timeoutMs: modelTurnTimeoutMs,
                stableWindowMs: this.limits.modelStableWindowMs,
                emptyResponseWindowMs: this.limits.emptyAssistantWindowMs,
                deadRequestGraceMs: this.limits.deadRequestGraceMs,
                readNativeImages: this.nativeImageReceiver
                  ? (message) => this.nativeImageReceiver.read(message) : null,
                readNativeMusic: this.nativeMusicReceiver
                  ? (message) => this.nativeMusicReceiver.read(message) : null,
                onDelta: async (delta) => {
                  await this.onEvent?.({
                    type: "model.streaming",
                    sessionId: this.session.sessionId,
                    timestamp: new Date().toISOString(),
                    payload: { delta },
                  });
                },
              });
              if (raw && typeof raw === "object" && Array.isArray(raw.nativeImages)) {
                nativeImages = raw.nativeImages;
                raw = raw.text ?? "";
              } else if (raw && typeof raw === "object" && Array.isArray(raw.nativeMusic)) {
                nativeMusic = raw.nativeMusic;
                raw = raw.text ?? "";
              }
            } finally {
              // Navigation events normally persist canonicalization immediately;
              // this validated fallback runs on every outcome but never masks a
              // completed reply or the original browser/model error.
              await this.#syncConversationIdentity({
                suppressErrors: true,
              });
            }
          }
          break;
        } catch (error) {
          if (isConnectionLostError(error)) {
            if (connectionRetries >= 1) {
              throw error;
            }
            connectionRetries += 1;
            if (supportsStrictRecovery) {
              await this.adapter.detach?.();
              activeHandoff = await this.#recoverPendingConversation({
                pendingOutbound: null,
                pendingAssistantTurn: activeHandoff,
              });
            } else {
              const { checkpoint } = await this.#reconnectAndRestore({
                checkpointIdentity: (restoration) => (
                  this.#refreshHandoffAfterRestore(
                    activeHandoff,
                    restoration,
                  )
                ),
              });
              activeHandoff = checkpoint;
            }
            // The message was already sent before the connection died; resume
            // waiting for the reply on the restored exact conversation boundary.
            continue;
          }

          if (error?.code === "USAGE_LIMIT_REACHED") {
            // Detected by the adapter from the message's DOM (text + retry
            // button); surface the same event the text-based path emits.
            await this.emit("model.limit_reached", {
              snippet: error.message,
            });
            throw error;
          }

          const deadRequest = error?.code === "DEAD_ASSISTANT_REQUEST";
          const generationFailed = error?.code === "GENERATION_FAILED";
          if (this.nativeMusicReceiver) throw error;
          if (
            error?.code !== "EMPTY_ASSISTANT_RESPONSE"
            && !deadRequest
            && !generationFailed
          ) {
            throw error;
          }

          const emptyAssistantMessageId = await this.adapter
            .getLastAssistantMessageId?.() ?? null;
          await this.session.update({
            lastAssistantMessageId: emptyAssistantMessageId
              ?? this.session.state.lastAssistantMessageId,
          });

          if (
            emptyAssistantRetries
            >= this.limits.maxEmptyAssistantRetries
          ) {
            await this.emit("model.empty_response_exhausted", {
              retries: emptyAssistantRetries,
              assistantMessageId: emptyAssistantMessageId,
              deadRequest,
              generationFailed,
            });
            throw new BrowserAdapterError(
              deadRequest
                ? `${this.adapter.providerName} did not respond after ${emptyAssistantRetries} continuation attempts.`
                : generationFailed
                  ? `${this.adapter.providerName} generation kept failing after ${emptyAssistantRetries} continuation attempts.`
                  : `${this.adapter.providerName} returned empty responses after ${emptyAssistantRetries} continuation attempts.`,
              {
                code: "EMPTY_ASSISTANT_RETRIES_EXHAUSTED",
                cause: error,
                details: { retries: emptyAssistantRetries },
              },
            );
          }

          emptyAssistantRetries += 1;
          await this.emit("model.empty_response", {
            retry: emptyAssistantRetries,
            maxRetries: this.limits.maxEmptyAssistantRetries,
            assistantMessageId: emptyAssistantMessageId,
            deadRequest,
            generationFailed,
          });
          // Do not resend the original request or tool result: both are already
          // present in ChatGPT's conversation. This transport-only continuation
          // also cannot re-execute a local tool by itself.
          const continuationSend = await this.sendMessage(
            deadRequest
              ? DEAD_REQUEST_CONTINUE_MESSAGE
              : generationFailed
                ? GENERATION_FAILED_CONTINUE_MESSAGE
                : EMPTY_ASSISTANT_CONTINUE_MESSAGE,
            {
              allowAssistantContinuation: true,
              outboundKind: deadRequest
                ? "dead_request_recovery"
                : generationFailed
                  ? "generation_failed_recovery"
                  : "empty_response_recovery",
              runtimeTurn: turnNumber,
              pendingToolAcknowledgement:
                activeHandoff.pendingToolAcknowledgement ?? null,
            },
          );
          activeHandoff = continuationSend.pendingAssistantTurn;
          await this.emit("model.message_sent", {
            kind: deadRequest
              ? "dead_request_recovery"
              : generationFailed
                ? "generation_failed_recovery"
                : "empty_response_recovery",
            retry: emptyAssistantRetries,
          });
        }
      }
      const assistantMessageId = activeHandoff.status === "complete"
        ? activeHandoff.assistantMessageId ?? null
        : await this.adapter.getLastAssistantMessageId?.() ?? null;
      const assistantTurn = activeHandoff.status === "complete"
        ? activeHandoff.assistantTurn ?? null
        : await this.adapter.getLastAssistantTurn?.() ?? null;
      if (activeHandoff.status === "waiting") {
        activeHandoff = await this.#queueSessionOperation(() => (
          this.session.completePendingAssistantTurn({
            handoffId: activeHandoff.handoffId,
            assistantMessageId,
            assistantTurn,
            rawResponse: raw,
            nativeImages,
            nativeMusic,
          })
        ));
      } else {
        const rawHash = createHash("sha256").update(raw).digest("hex");
        if (rawHash !== activeHandoff.responseHash) {
          throw new BrowserAdapterError(
            "The durable assistant response changed before processing.",
            { code: "ASSISTANT_HANDOFF_COLLISION", recoverable: false },
          );
        }
      }
      if (awaitingPendingAcknowledgement) {
        await this.#queueSessionUpdate({ pendingToolResult: null });
      }
      awaitingPendingAcknowledgement = false;
      await this.emit("model.message_complete", {
        turn: turnNumber,
        raw,
        assistantMessageId,
      });

      if (this.nativeMusicReceiver) {
        let artifacts = activeHandoff.nativeArtifacts;
        if (!artifacts) {
          artifacts = nativeMusic.length ? await this.nativeMusicReceiver.save(nativeMusic, {
            projectRoot, handoffId: activeHandoff.handoffId, assistantMessageId,
          }) : [];
          activeHandoff = await this.#queueSessionOperation(() => (
            this.session.refreshPendingAssistantTurn(activeHandoff.handoffId, { nativeArtifacts: artifacts })
          ));
        }
        const message = [
          raw,
          ...artifacts.map((artifact) => `Saved music: ${artifact.localPath} (${artifact.durationSeconds.toFixed(2)} s)`),
          ...artifacts.map((artifact) => artifact.audioExtractionNote).filter(Boolean),
          ...(artifacts.length ? [] : ["No music file was generated or saved."]),
        ].filter(Boolean).join("\n");
        await this.#appendHandoffTranscript(activeHandoff, "assistant", assistantMessage(message));
        const result = { message, artifacts };
        await this.#queueSessionOperation(() => this.session.clearPendingAssistantTurn(activeHandoff.handoffId, {
          phase: "idle", lastMessage: message, pendingToolResult: null, lastMusicResult: result,
        }));
        if (artifacts.length) await this.emit("model.native_music", { turn: turnNumber, artifacts });
        await this.emit("run.completed", result);
        return { sessionId: this.session.sessionId, ...result };
      }

      if (nativeImages.length > 0) {
        if (!this.nativeImageReceiver) {
          throw new Error("This session has pending native images but no image receiver.");
        }
        let artifacts = activeHandoff.nativeArtifacts;
        if (!artifacts) {
          artifacts = await this.nativeImageReceiver.save(nativeImages, {
            projectRoot,
            handoffId: activeHandoff.handoffId,
            assistantMessageId,
          });
          activeHandoff = await this.#queueSessionOperation(() => (
            this.session.refreshPendingAssistantTurn(activeHandoff.handoffId, { nativeArtifacts: artifacts })
          ));
        }
        protocolErrors = 0;
        const message = [raw, ...artifacts.map((artifact) => `Saved image: ${artifact.localPath}`)]
          .filter(Boolean).join("\n");
        await this.#appendHandoffTranscript(activeHandoff, "assistant", assistantMessage(message));
        await this.emit("model.native_images", { turn: turnNumber, artifacts });
        await this.emit("model.progress", { turn: turnNumber, message });
        const receipt = artifacts.map(({ localPath, mimeType, width, height, size, sha256 }) => (
          { localPath, mimeType, width, height, size, sha256 }
        ));
        await this.sendMessage(
          `<native_image_result>${cdata(JSON.stringify(receipt))}</native_image_result>\n`
            + "The images from your preceding reply are saved at these verified local paths. "
            + "Continue the user's original task. Generate further images directly if needed; "
            + "use local tools for file operations, or finish with a done=true XML answer.",
          { outboundKind: "native_image_result", runtimeTurn: turnNumber + 1 },
        );
        continue;
      }

      let parsed;
      let finalMessage;
      let usedTrailingProse = false;
      try {
        parsed = parseAgentResponse(raw);
        finalMessage = parsed.message;
        // Some providers put the deliverable after a done=true envelope. Merge
        // that display text before validating the final answer.
        if (parsed.done) {
          const trailing = extractTrailingProse(raw);
          if (trailing) {
            finalMessage = [parsed.message.trim(), trailing]
              .filter(Boolean)
              .join("\n\n");
            usedTrailingProse = true;
          }
          if (!finalMessage.trim()) {
            throw new ProtocolError("done=true requires a non-empty final message.");
          }
          if (
            !parsed.toolCall
            && /<tool_calls[\s>]|<tool_call[\s>]|<invoke[\s>]/i.test(finalMessage)
          ) {
            throw new ProtocolError(
              "Tool calls must use the <tool_call> element, not the <message> text.",
            );
          }
        }
        // Syntax and semantic errors share one consecutive-retry budget.
        protocolErrors = 0;
      } catch (error) {
        if (!(error instanceof ProtocolError)) {
          throw error;
        }
        if (isUsageLimitNotice(raw)) {
          // ChatGPT renders its plan/usage limit as a normal assistant message
          // (localized). A failed parse whose text matches is a limit notice,
          // not a format slip: retrying is futile, so stop the run with a
          // clear error instead of burning retries and the model timeout.
          await this.emit("model.limit_reached", {
            snippet: raw.slice(0, 200),
          });
          throw new BrowserAdapterError(
            `${this.adapter.providerName} reported a usage limit. Wait for the limit `
              + "to reset, try a different mode on resume, or change plans, then resume.",
            { code: "USAGE_LIMIT_REACHED" },
          );
        }

        // A finished native refusal/clarification is data for the agent, not a
        // successful image or an empty-response retry. Keep a bounded budget;
        // malformed XML still follows strict protocol correction below.
        if (this.nativeImageReceiver && raw.trim() && !/<\/?(?:agent_response|tool_call|tool_calls|invoke|done|message)(?:\s|>)/i.test(raw)) {
          protocolErrors += 1;
          await this.#appendHandoffTranscript(activeHandoff, "assistant", assistantMessage(raw));
          await this.emit("model.progress", { turn: turnNumber, message: raw });
          if (protocolErrors >= this.limits.maxProtocolErrors) {
            throw new ProtocolError("The provider repeatedly returned text without a completed XML answer or an image.");
          }
          await this.sendMessage(
            `<native_image_result type="text">${cdata(raw)}</native_image_result>\n`
              + "Your preceding reply contained only this text; no image was received or saved. "
              + "Continue the original task based on this result. If generation is unavailable or declined, "
              + "explain it or ask the user a specific question in a done=true XML answer. Do not automatically retry the same image request.",
            { outboundKind: "native_image_text", runtimeTurn: turnNumber + 1 },
          );
          continue;
        }

        // Absence of an envelope is a protocol failure, not proof of done.
        // This also covers UI-only text and partial native-artifact responses.
        await this.adapter.writeDiagnostics?.("protocol-invalid", {
          turn: turnNumber,
          assistantMessageId,
          error: error.message,
        }).catch(() => null);
        protocolErrors += 1;
        await this.emit("protocol.invalid", {
          message: error.message,
          count: protocolErrors,
        });
        if (protocolErrors >= this.limits.maxProtocolErrors) {
          throw new ProtocolError(
            `Protocol failed ${protocolErrors} consecutive times: ${error.message}`,
          );
        }
        await this.sendMessage(serializeProtocolError(error), {
          allowAssistantContinuation: true,
          outboundKind: "protocol_correction",
          runtimeTurn: turnNumber + 1,
        });
        continue;
      }

      // Record the assistant's turn in the canonical transcript. The raw XML is
      // the web rendering; the transcript keeps the plain progress message.
      if (finalMessage?.trim()) {
        await this.#appendHandoffTranscript(
          activeHandoff,
          "assistant",
          assistantMessage(finalMessage),
        );
      }

      if (parsed.done) {
        // done=true completes the run. A request may be answered directly
        // (no tool call) or after any number of tools; the runtime does not
        // second-guess whether "enough" work happened — that is the model's
        // and the user's call, not a keyword heuristic.
        await this.#queueSessionOperation(() => (
          this.session.clearPendingAssistantTurn(
            activeHandoff.handoffId,
            {
              phase: "idle",
              lastMessage: finalMessage,
              pendingToolResult: null,
            },
          )
        ));
        await this.emit("run.completed", {
          message: finalMessage,
          usedTrailingProse,
        });
        return {
          sessionId: this.session.sessionId,
          message: finalMessage,
        };
      }

      if (parsed.message) {
        await this.emit("model.progress", {
          turn: turnNumber,
          message: parsed.message,
        });
      }

      if (!parsed.toolCall) {
        // done=false without a tool call means the model is just talking
        // (e.g. asking a clarifying question, explaining its reasoning, or
        // giving a partial answer). The message was already emitted as
        // model.progress above; nudge the model to either finish with
        // done=true or invoke a local tool to make progress.
        await this.sendMessage(
          "If the current request is deliverable, reply with <done>true</done> and the result. "
            + "If you need to take action on the user's machine, request one local tool. "
            + "If you need information from the user, ask one specific question in <message> "
            + "and set <done>true</done> so control returns to the user.",
          {
            allowAssistantContinuation: true,
            outboundKind: "progress_correction",
            runtimeTurn: turnNumber + 1,
          },
        );
        continue;
      }

      const identity = deriveToolIdentity({
        sessionId: this.session.sessionId,
        assistantMessageId,
        turn: parsed,
        toolCall: parsed.toolCall,
        turnNumber,
      });
      const normalizedCall = {
        ...parsed.toolCall,
        id: identity.callId,
      };
      let preparedCall;
      try {
        preparedCall = this.registry.validate(normalizedCall);
      } catch (error) {
        if (!(error instanceof ToolValidationError)) {
          throw error;
        }

        const result = {
          callId: normalizedCall.id,
          name: normalizedCall.name,
          ok: false,
          message: error.message,
        };
        const fingerprint = identity.fingerprint;
        await this.emit("tool.invalid", {
          id: normalizedCall.id,
          name: normalizedCall.name,
          message: error.message,
        });
        const completionEvent = await this.session.recordToolResult(
          fingerprint,
          result,
        );
        await this.onEvent?.(completionEvent);
        // Record the rejected call and its error output so the transcript stays
        // a faithful, replay-free record of what the model attempted.
        await this.#appendHandoffTranscript(
          activeHandoff,
          "function_call",
          functionCall({
            name: normalizedCall.name,
            args: normalizedCall.args,
            callId: normalizedCall.id,
          }),
        );
        await this.#appendHandoffTranscript(
          activeHandoff,
          "function_output",
          functionCallOutput({
            callId: result.callId,
            output: toolResultOutput(result),
          }),
        );
        await this.sendToolResult(result, { runtimeTurn: turnNumber + 1 });
        awaitingPendingAcknowledgement = true;
        await this.emit("tool.result_sent", {
          id: result.callId,
          name: result.name,
          ok: false,
        });
        continue;
      }
      await this.emit("tool.proposed", {
        id: preparedCall.id,
        name: preparedCall.name,
        args: preparedCall.args,
      });
      await this.#appendHandoffTranscript(
        activeHandoff,
        "function_call",
        functionCall({
          name: preparedCall.name,
          args: preparedCall.args,
          callId: preparedCall.id,
        }),
      );

      const isReadTool = preparedCall.definition.risk === "read";
      const sideEffect = isReadTool ? null : identity;
      const fingerprint = identity.fingerprint;
      let result;
      let restoredForTool = false;

      if (
        sideEffect
        && replayGuard?.signature === identity.requestSignature
      ) {
        result = {
          ...replayGuard.result,
          callId: preparedCall.id,
        };
        await this.emit("tool.reused", {
          fingerprint,
          id: preparedCall.id,
          name: preparedCall.name,
          reason: "repeated-after-result",
        });
        await this.session.setPendingToolResult(result);
      }
      // The replay guard is only for the first tool proposal after resending a
      // persisted result during recovery. Later identical proposals are new
      // model turns and may be deliberate operations.
      replayGuard = null;

      if (!result && sideEffect) {
        const existing = this.session.getSideEffectTool(
          sideEffect.operationKey,
        );
        if (existing && existing.fingerprint !== identity.fingerprint) {
          result = {
            callId: preparedCall.id,
            name: preparedCall.name,
            ok: false,
            message:
              "The same assistant message changed its tool request after it "
              + `was already recorded for ${existing.name}. The operation was not replayed.`,
          };
          await this.emit("tool.conflict", {
            id: preparedCall.id,
            name: preparedCall.name,
            existingName: existing.name,
          });
          await this.session.setPendingToolResult(result);
        } else if (existing?.status === "completed") {
          result = existing.result;
          await this.emit("tool.reused", {
            fingerprint,
            id: preparedCall.id,
            name: preparedCall.name,
          });
          await this.session.setPendingToolResult(result);
        } else if (existing) {
          result = existing.result ?? unknownCompletionResult(preparedCall);
          if (existing.status !== "unknown") {
            const unknownEvent = await this.session.markSideEffectToolUnknown(
              identity,
              result,
            );
            await this.onEvent?.(unknownEvent);
          } else {
            await this.session.setPendingToolResult(result);
          }
          await this.emit("tool.reused_unknown", {
            fingerprint,
            id: preparedCall.id,
            name: preparedCall.name,
          });
        }
      } else if (!result) {
        result = this.session.getToolResult(fingerprint);
      }

      if (!result) {
        let decision;
        try {
          decision = await this.policy.evaluate(preparedCall, {
            projectRoot,
          });
        } catch (error) {
          result = policyRejectedResult(preparedCall, error.message);
          await this.emit("tool.invalid", {
            id: preparedCall.id,
            name: preparedCall.name,
            message: result.message,
          });
        }
        const grants = decision?.grants;

        if (!result && decision.action === "confirm") {
          await this.emit("approval.required", {
            id: preparedCall.id,
            name: preparedCall.name,
            args: preparedCall.args,
            reasons: decision.reasons,
          });
          const approved = await this.approval({
            toolCall: preparedCall,
            reasons: decision.reasons,
          });
          if (!approved) {
            result = deniedResult(preparedCall, decision.reasons);
          }
        } else if (!result && decision.action === "deny") {
          result = policyRejectedResult(
            preparedCall,
            decision.reasons.join("; "),
          );
          await this.emit("tool.invalid", {
            id: preparedCall.id,
            name: preparedCall.name,
            message: result.message,
          });
        }

        if (sideEffect) {
          const claimEvent = await this.session.claimSideEffectTool(sideEffect);
          await this.onEvent?.(claimEvent);
        }

        if (!result) {
          if (preparedCall.definition.requiresVisibleBrowser) {
            await this.adapter.restoreWindow?.();
            restoredForTool = true;
          }
          await this.emit("tool.started", {
            id: preparedCall.id,
            name: preparedCall.name,
          });
          try {
            result = await this.registry.execute(preparedCall, {
              projectRoot,
              allowOutside: grants?.allowOutside ?? false,
              toolTimeoutMs: this.limits.toolTimeoutMs,
              sessionId: this.session.sessionId,
              operationKey: identity.operationKey,
              requestSignature: identity.requestSignature,
              runAuxiliaryTurn: (options) => this.runAuxiliaryTurn(options),
              onToolOutput: async (output) => {
                await this.session.appendToolOutput({
                  id: preparedCall.id,
                  name: preparedCall.name,
                  ...output,
                });
                await this.onEvent?.({
                  type: "tool.output",
                  sessionId: this.session.sessionId,
                  timestamp: new Date().toISOString(),
                  payload: {
                    id: preparedCall.id,
                    name: preparedCall.name,
                    ...output,
                  },
                });
              },
            });
          } finally {
            if (restoredForTool) {
              await this.adapter.page?.bringToFront?.().catch(() => null);
            }
          }
        }

        if (sideEffect) {
          result.operationSignature = identity.requestSignature;
        }

        if (sideEffect && result.meta?.completionUnknown) {
          const unknownEvent = await this.session.markSideEffectToolUnknown(
            sideEffect,
            result,
          );
          await this.onEvent?.(unknownEvent);
        } else {
          const completionEvent = await this.session.recordToolResult(
            fingerprint,
            result,
            { identity: sideEffect },
          );
          await this.onEvent?.(completionEvent);
        }
      }

      this.#assertProviderReadyForMessage();

      await this.#appendHandoffTranscript(
        activeHandoff,
        "function_output",
        functionCallOutput({
          callId: result.callId,
          output: toolResultOutput(result),
        }),
      );
      await this.sendToolResult(result, { runtimeTurn: turnNumber + 1 });
      awaitingPendingAcknowledgement = true;
      await this.emit("tool.result_sent", {
        id: result.callId,
        name: result.name,
        ok: result.ok,
      });
      if (restoredForTool) {
        await this.adapter.minimizeWindow?.();
      }
    }

  }
}
