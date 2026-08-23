import { createHash } from "node:crypto";
import {
  cdata,
  extractTrailingProse,
  parseAgentResponse,
  serializeProtocolError,
  serializeToolResult,
  stripUiNoiseLines,
} from "../protocol/xml-protocol.js";
import { appendSystemReminder } from "../protocol/markers.js";
import {
  buildBootstrapPrompt,
  buildResumePrompt,
} from "../protocol/prompt-builder.js";
import {
  assistantMessage,
  functionCall,
  functionCallOutput,
  toolResultOutput,
  userMessage,
} from "../session/canonical-transcript.js";
import {
  DEFAULT_LIMITS,
  PRO_MODEL_TURN_TIMEOUT_MS,
  isProMode,
} from "../shared/limits.js";
import { utf8ByteLength } from "../shared/text-budget.js";
import {
  BrowserAdapterError,
  ProtocolError,
  ToolValidationError,
} from "../shared/errors.js";
import { isConnectionLostError } from "../browser/base-web-adapter.js";
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
    limits = DEFAULT_LIMITS,
  }) {
    this.adapter = adapter;
    this.registry = registry;
    this.policy = policy;
    this.session = session;
    this.approval = approval;
    this.onEvent = onEvent;
    this.limits = limits;
  }

  async emit(type, payload = {}) {
    const event = await this.session.appendEvent(type, payload);
    await this.onEvent?.(event);
    return event;
  }

  async sendMessage(text, { files = [], maxBytes = null } = {}) {
    const message = appendSystemReminder(text);
    try {
      await this.#sendMessageWithReconnect(message, { files, maxBytes });
    } finally {
      const conversationUrl = await this.adapter.getConversationUrl()
        .catch(() => null);
      if (
        conversationUrl
        && conversationUrl !== this.session.state.conversationUrl
      ) {
        await this.session.update({ conversationUrl });
      }
    }
  }

  // Sends once; if the browser connection died in between (e.g. the Mac slept
  // while a tool was running), reconnects to the still-alive Chrome, restores
  // the conversation, and retries once. A send that never rendered (ChatGPT
  // did not register the message) is also retried once — the deterministic
  // message is simply sent again. Anything else propagates.
  async #sendMessageWithReconnect(message, { files, maxBytes }) {
    try {
      await this.adapter.sendMessage(message, { files, maxBytes });
    } catch (error) {
      if (isConnectionLostError(error)) {
        await this.#reconnectAndRestore();
        await this.adapter.sendMessage(message, { files, maxBytes });
        return;
      }
      if (error?.code === "SEND_NOT_DETECTED") {
        await this.adapter.sendMessage(message, { files, maxBytes });
        return;
      }
      throw error;
    }
  }

  // Reconnects to the still-alive Chrome and navigates back to the session's
  // conversation, so the DOM state needed by the adapter is restored.
  async #reconnectAndRestore() {
    await this.adapter.reconnect?.(this.session.state.conversationUrl);
    await this.adapter.startConversation(
      this.session.state.conversationUrl,
      {
        expectedAssistantMessageId: this.session.state.lastAssistantMessageId
          ?? null,
      },
    );
  }

  buildToolResultMessage(result, { suffix = "" } = {}) {
    const limit = this.limits.maxBrowserToolResultBytes;
    const nonResultBytes = utf8ByteLength(appendSystemReminder(suffix));
    const resultBudget = limit - nonResultBytes;
    if (resultBudget < 512) {
      throw new RangeError(
        `Tool result metadata leaves fewer than 512 bytes within the ${limit}-byte browser limit.`,
      );
    }
    return `${serializeToolResult(result, { maxBytes: resultBudget })}${suffix}`;
  }

  async sendToolResult(result, { suffix = "" } = {}) {
    await this.sendMessage(this.buildToolResultMessage(result, { suffix }), {
      maxBytes: this.limits.maxBrowserToolResultBytes,
    });
  }

  async run({
    resume = false,
    instruction = null,
    files = [],
    inPlaceRecovery = false,
    mode = null,
  } = {}) {
    const {
      task,
      projectRoot,
      mode: sessionMode,
    } = this.session.state;
    const previousConversationUrl = this.session.state.conversationUrl;
    await this.session.recoverInterruptedSideEffects();
    const pendingToolResult = this.session.state.pendingToolResult;

    await this.session.update({
      phase: "initializing",
      runCount: Number(this.session.state.runCount || 0) + 1,
      lastError: null,
    });
    await this.emit("runtime.initializing");

    // On resume, prefer an existing tab already showing the conversation so
    // repeated resumes reuse the same tab instead of piling up new ones.
    await this.adapter.launch(
      resume ? this.session.state.conversationUrl : null,
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

    await this.adapter.startConversation(
      resume ? previousConversationUrl : null,
      {
        expectedAssistantMessageId: resume
          ? this.session.state.lastAssistantMessageId
          : null,
      },
    );
    // A fresh run uses the mode stored at session creation; a resume applies
    // an explicit mode override (--mode or the interactive choice) when given,
    // and otherwise keeps the mode the conversation is already on.
    const requestedMode = mode ?? sessionMode;
    // The actual mode may differ from the requested one (Pro limited, fallback,
    // or switcher not found), so report what was really selected.
    let activeMode = resume
      ? (this.session.state.activeMode ?? null)
      : null;
    const selectRequested = Boolean(
      requestedMode && (!resume || mode != null),
    );
    if (selectRequested) {
      const modeResult = await this.adapter.selectMode(requestedMode);
      if (modeResult) {
        await this.emit("conversation.mode_selected", {
          requested: requestedMode,
          status: modeResult.status,
          selectedLabel: modeResult.selectedLabel ?? null,
          attempts: modeResult.attempts ?? 0,
          reason: modeResult.reason ?? null,
        });
        if (modeResult.status === "select" || modeResult.status === "already") {
          activeMode = modeResult.selectedLabel ?? requestedMode;
        } else if (modeResult.status === "fallback") {
          activeMode = modeResult.selectedLabel ?? requestedMode;
        } else {
          // Pro not selected and no known fallback label — the real mode is
          // whatever ChatGPT already had, which we cannot name reliably.
          activeMode = null;
        }
      }
    }
    // ChatGPT Pro can think considerably longer before the first token;
    // every other provider/mode uses the default. An explicit
    // --model-turn-timeout-ms always wins (resolveLimits marks it). The
    // active mode may differ from the requested one (Pro limited, fallback),
    // so prefer the mode the conversation is actually on.
    const modelTurnTimeoutMs = !this.limits.modelTurnTimeoutExplicit
      && (isProMode(activeMode) || isProMode(requestedMode))
      ? PRO_MODEL_TURN_TIMEOUT_MS
      : this.limits.modelTurnTimeoutMs;

    await this.session.update({
      phase: "running",
      conversationUrl: await this.adapter.getConversationUrl(),
      activeMode,
    });
    await this.emit("conversation.started", {
      url: this.session.state.conversationUrl,
      mode: activeMode,
      requestedMode,
    });

    let initialMessage;
    let initialKind;
    // The web transport gets `.web` (XML/marked text). The portable rollout
    // records only the real user message; WTAgent scaffolding stays transport-only.
    let initialTranscript = [];
    // @file attachments (if any) accompany the first user message of this run.
    const attachments = (files ?? []).map((file) => ({
      name: file.name ?? null,
      path: file.path ?? null,
    }));
    const messageOptions = attachments.length > 0 ? { attachments } : {};
    if (resume && pendingToolResult && !inPlaceRecovery) {
      let suffix = "";
      if (instruction?.trim()) {
        suffix = `\n<resume_instruction>${cdata(instruction)}</resume_instruction>`;
        initialTranscript = [userMessage(instruction, messageOptions)];
      }
      initialMessage = this.buildToolResultMessage(pendingToolResult, { suffix });
      initialKind = "pending_tool_result";
    } else if (resume && instruction?.trim()) {
      // The live web conversation already contains the bootstrap protocol
      // and tool catalog. A normal follow-up should be the user's message, not
      // another several-thousand-character protocol bootstrap. sendMessage()
      // still appends the short format reminder.
      initialMessage = instruction.trim();
      initialTranscript = [userMessage(instruction.trim(), messageOptions)];
      initialKind = "follow_up";
    } else if (resume && inPlaceRecovery) {
      // The original request/tool result is already visible in this live web
      // conversation. Ask the provider to continue without duplicating transport
      // payloads, attachments, or canonical transcript entries.
      initialMessage = EMPTY_ASSISTANT_CONTINUE_MESSAGE;
      initialKind = "empty_response_recovery";
    } else if (resume) {
      const prompt = buildResumePrompt({
        instruction,
        state: this.session.state,
        tools: this.registry.list(),
      });
      initialMessage = prompt.web;
      initialTranscript = [userMessage(prompt.user, messageOptions)];
      initialKind = "resume";
    } else {
      const prompt = buildBootstrapPrompt({
        task,
        projectRoot,
        tools: this.registry.list(),
      });
      initialMessage = prompt.web;
      initialTranscript = [userMessage(prompt.user, messageOptions)];
      initialKind = "bootstrap";
    }

    for (const item of initialTranscript) {
      await this.session.appendTranscriptItem(item);
    }
    await this.sendMessage(initialMessage, {
      files,
      maxBytes: initialKind === "pending_tool_result"
        ? this.limits.maxBrowserToolResultBytes
        : null,
    });
    let awaitingPendingAcknowledgement = Boolean(pendingToolResult);
    let replayGuard = pendingToolResult?.operationSignature
      ? {
        signature: pendingToolResult.operationSignature,
        result: pendingToolResult,
      }
      : null;
    await this.emit("model.message_sent", { kind: initialKind });

    let protocolErrors = 0;
    const baseTurn = resume ? Number(this.session.state.turn || 0) : 0;

    for (let step = 1; ; step += 1) {
      const turnNumber = baseTurn + step;
      await this.session.update({ turn: turnNumber, phase: "waiting_model" });
      let raw;
      let emptyAssistantRetries = 0;
      let connectionRetries = 0;
      for (;;) {
        try {
          raw = await this.adapter.waitForTurnComplete({
            timeoutMs: modelTurnTimeoutMs,
            stableWindowMs: this.limits.modelStableWindowMs,
            emptyResponseWindowMs: this.limits.emptyAssistantWindowMs,
            deadRequestGraceMs: this.limits.deadRequestGraceMs,
            onDelta: async (delta) => {
              await this.onEvent?.({
                type: "model.streaming",
                sessionId: this.session.sessionId,
                timestamp: new Date().toISOString(),
                payload: { delta },
              });
            },
          });
          break;
        } catch (error) {
          if (isConnectionLostError(error)) {
            if (connectionRetries >= 1) {
              throw error;
            }
            connectionRetries += 1;
            await this.#reconnectAndRestore();
            // The message was already sent before the connection died; resume
            // waiting for the reply on the restored page.
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
            conversationUrl: await this.adapter.getConversationUrl(),
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
          await this.sendMessage(
            deadRequest
              ? DEAD_REQUEST_CONTINUE_MESSAGE
              : generationFailed
                ? GENERATION_FAILED_CONTINUE_MESSAGE
                : EMPTY_ASSISTANT_CONTINUE_MESSAGE,
          );
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
      const assistantMessageId = await this.adapter
        .getLastAssistantMessageId?.() ?? null;
      if (awaitingPendingAcknowledgement) {
        await this.session.clearPendingToolResult();
        awaitingPendingAcknowledgement = false;
      }
      await this.session.update({
        conversationUrl: await this.adapter.getConversationUrl(),
        // Null is meaningful: retaining an older ID would falsely prove only
        // that stale history had hydrated on the next resume.
        lastAssistantMessageId: assistantMessageId,
      });
      await this.emit("model.message_complete", {
        turn: turnNumber,
        raw,
        assistantMessageId,
      });

      let parsed;
      try {
        parsed = parseAgentResponse(raw);
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

        // The model answered in plain prose without any <agent_response> at
        // all. That cannot be a broken tool request (tools only exist inside a
        // parsed envelope), so it is safe to treat the prose as the final
        // answer: end the run and show it, instead of burning retries on a
        // model that deliberately finished the conversation. A reply that DOES
        // contain <agent_response but fails to parse keeps the retry path —
        // the model tried the protocol and we must not guess its intent.
        // A bare <tool_calls>/<invoke> reply (no envelope) is likewise a tool
        // REQUEST, never prose: it goes to the protocol-error retry below.
        const looksLikeToolRequest = /<tool_calls[\s>]|<tool_call[\s>]|<invoke[\s>]/i
          .test(raw);
        const plainAnswer = !raw.includes("<agent_response")
          && !looksLikeToolRequest
          ? stripUiNoiseLines(raw)
          : "";
        if (plainAnswer) {
          await this.emit("protocol.plain_answer", {
            snippet: plainAnswer.slice(0, 200),
          });
          await this.session.update({
            phase: "idle",
            lastMessage: plainAnswer,
            pendingToolResult: null,
          });
          await this.session.appendTranscriptItem(assistantMessage(plainAnswer));
          await this.emit("run.completed", {
            message: plainAnswer,
            plainAnswer: true,
          });
          return {
            sessionId: this.session.sessionId,
            message: plainAnswer,
          };
        }

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
        await this.sendMessage(serializeProtocolError(error));
        continue;
      }

      // When the run finishes, some models (GLM especially) put their real
      // deliverable AFTER the envelope: a short done/true stub followed by the
      // full markdown/HTML answer. That trailing prose is pure display content
      // (it cannot trigger a tool), so merge it into the final message instead
      // of dropping it. Non-done turns keep the protocol message untouched.
      let finalMessage = parsed.message;
      let usedTrailingProse = false;
      if (parsed.done) {
        const trailing = extractTrailingProse(raw);
        if (trailing) {
          finalMessage = [parsed.message.trim(), trailing]
            .filter(Boolean)
            .join("\n\n");
          usedTrailingProse = true;
        }
      }

      // Record the assistant's turn in the canonical transcript. The raw XML is
      // the web rendering; the transcript keeps the plain progress message.
      if (finalMessage?.trim()) {
        await this.session.appendTranscriptItem(
          assistantMessage(finalMessage),
        );
      }

      if (parsed.done) {
        if (!finalMessage.trim()) {
          const error = new ProtocolError(
            "done=true requires a non-empty final message.",
          );
          await this.emit("protocol.invalid", { message: error.message });
          await this.sendMessage(serializeProtocolError(error));
          continue;
        }
        // Some models (DeepSeek especially) write their tool request inside
        // the <message> of a done=true envelope instead of a <tool_call>
        // element. Completing there would swallow the tool call and end the
        // run with raw XML as the "answer". Treat it as a format slip: the
        // protocol-error feedback tells the model where tool calls go, and
        // the normal retry limit still applies.
        if (
          !parsed.toolCall
          && /<tool_calls[\s>]|<tool_call[\s>]|<invoke[\s>]/i.test(finalMessage)
        ) {
          const error = new ProtocolError(
            "Tool calls must use the <tool_call> element, not the <message> text.",
          );
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
          await this.sendMessage(serializeProtocolError(error));
          continue;
        }
        // done=true completes the run. A request may be answered directly
        // (no tool call) or after any number of tools; the runtime does not
        // second-guess whether "enough" work happened — that is the model's
        // and the user's call, not a keyword heuristic.
        await this.session.update({
          phase: "idle",
          lastMessage: finalMessage,
          pendingToolResult: null,
        });
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
        await this.session.appendTranscriptItem(functionCall({
          name: normalizedCall.name,
          args: normalizedCall.args,
          callId: normalizedCall.id,
        }));
        await this.session.appendTranscriptItem(functionCallOutput({
          callId: result.callId,
          output: toolResultOutput(result),
        }));
        await this.sendToolResult(result);
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
      await this.session.appendTranscriptItem(functionCall({
        name: preparedCall.name,
        args: preparedCall.args,
        callId: preparedCall.id,
      }));

      const isReadTool = preparedCall.definition.risk === "read";
      const sideEffect = isReadTool ? null : identity;
      const fingerprint = identity.fingerprint;
      let result;

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
          await this.emit("tool.started", {
            id: preparedCall.id,
            name: preparedCall.name,
          });
          result = await this.registry.execute(preparedCall, {
            projectRoot,
            allowOutside: grants?.allowOutside ?? false,
            toolTimeoutMs: this.limits.toolTimeoutMs,
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

      await this.session.appendTranscriptItem(functionCallOutput({
        callId: result.callId,
        output: toolResultOutput(result),
      }));
      await this.sendToolResult(result);
      awaitingPendingAcknowledgement = true;
      await this.emit("tool.result_sent", {
        id: result.callId,
        name: result.name,
        ok: result.ok,
      });
    }

  }
}
