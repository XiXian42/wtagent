import { createHash } from "node:crypto";
import {
  cdata,
  parseAgentResponse,
  serializeProtocolError,
  serializeToolResult,
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
import { DEFAULT_LIMITS } from "../shared/limits.js";
import {
  PolicyDeniedError,
  ProtocolError,
  ToolValidationError,
} from "../shared/errors.js";

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

  async sendMessage(text, { files = [] } = {}) {
    try {
      await this.adapter.sendMessage(appendSystemReminder(text), { files });
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

  async run({
    resume = false,
    instruction = null,
    files = [],
  } = {}) {
    const {
      task,
      projectRoot,
      mode,
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

    await this.adapter.launch();
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

    await this.adapter.startConversation(resume ? previousConversationUrl : null);
    // The actual mode may differ from the requested one (Pro limited, fallback,
    // or switcher not found), so report what was really selected.
    let activeMode = mode;
    if (!resume) {
      const modeResult = await this.adapter.selectMode(mode);
      if (modeResult) {
        await this.emit("conversation.mode_selected", {
          requested: mode,
          status: modeResult.status,
          selectedLabel: modeResult.selectedLabel ?? null,
          attempts: modeResult.attempts ?? 0,
          reason: modeResult.reason ?? null,
        });
        if (modeResult.status === "select" || modeResult.status === "already") {
          activeMode = modeResult.selectedLabel ?? mode;
        } else if (modeResult.status === "fallback") {
          activeMode = modeResult.selectedLabel ?? mode;
        } else {
          // Pro not selected and no known fallback label — the real mode is
          // whatever ChatGPT already had, which we cannot name reliably.
          activeMode = null;
        }
      }
    }
    await this.session.update({
      phase: "running",
      conversationUrl: await this.adapter.getConversationUrl(),
    });
    await this.emit("conversation.started", {
      url: this.session.state.conversationUrl,
      mode: activeMode,
      requestedMode: mode,
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
    if (resume && pendingToolResult) {
      initialMessage = serializeToolResult(pendingToolResult);
      if (instruction?.trim()) {
        initialMessage += `\n<resume_instruction>${cdata(instruction)}</resume_instruction>`;
        initialTranscript = [userMessage(instruction, messageOptions)];
      }
      initialKind = "pending_tool_result";
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
    await this.sendMessage(initialMessage, { files });
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

    for (let step = 1; step <= this.limits.maxTurns; step += 1) {
      const turnNumber = baseTurn + step;
      await this.session.update({ turn: turnNumber, phase: "waiting_model" });
      const raw = await this.adapter.waitForTurnComplete({
        timeoutMs: this.limits.modelTurnTimeoutMs,
        stableWindowMs: this.limits.modelStableWindowMs,
        onDelta: async (delta) => {
          await this.onEvent?.({
            type: "model.streaming",
            sessionId: this.session.sessionId,
            timestamp: new Date().toISOString(),
            payload: { delta },
          });
        },
      });
      if (awaitingPendingAcknowledgement) {
        await this.session.clearPendingToolResult();
        awaitingPendingAcknowledgement = false;
      }
      await this.session.update({
        conversationUrl: await this.adapter.getConversationUrl(),
      });
      await this.emit("model.message_complete", {
        turn: turnNumber,
        raw,
      });

      let parsed;
      try {
        parsed = parseAgentResponse(raw);
        protocolErrors = 0;
      } catch (error) {
        if (!(error instanceof ProtocolError)) {
          throw error;
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

      // Record the assistant's turn in the canonical transcript. The raw XML is
      // the web rendering; the transcript keeps the plain progress message.
      if (parsed.message?.trim()) {
        await this.session.appendTranscriptItem(
          assistantMessage(parsed.message),
        );
      }

      if (parsed.done) {
        if (!parsed.message.trim()) {
          const error = new ProtocolError(
            "done=true requires a non-empty final message.",
          );
          await this.emit("protocol.invalid", { message: error.message });
          await this.sendMessage(serializeProtocolError(error));
          continue;
        }
        // done=true completes the run. A request may be answered directly
        // (no tool call) or after any number of tools; the runtime does not
        // second-guess whether "enough" work happened — that is the model's
        // and the user's call, not a keyword heuristic.
        await this.session.update({
          phase: "idle",
          lastMessage: parsed.message,
          pendingToolResult: null,
        });
        await this.emit("run.completed", { message: parsed.message });
        return {
          sessionId: this.session.sessionId,
          message: parsed.message,
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

      const assistantMessageId = await this.adapter
        .getLastAssistantMessageId?.() ?? null;
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
        await this.sendMessage(serializeToolResult(result));
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
        const decision = await this.policy.evaluate(preparedCall, {
          projectRoot,
        });
        const grants = decision.grants;

        if (decision.action === "confirm") {
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
        } else if (decision.action === "deny") {
          throw new PolicyDeniedError(decision.reasons.join("; "));
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
      await this.sendMessage(serializeToolResult(result));
      awaitingPendingAcknowledgement = true;
      await this.emit("tool.result_sent", {
        id: result.callId,
        name: result.name,
        ok: result.ok,
      });
    }

    const message = `Maximum turn limit reached (${this.limits.maxTurns}).`;
    await this.session.update({
      phase: "interrupted",
      lastError: message,
    });
    await this.emit("run.interrupted", { message });
    throw new Error(message);
  }
}
