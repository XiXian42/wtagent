export class FakeWebModelAdapter {
  constructor(responses = []) {
    this.responses = [...responses];
    this.sentMessages = [];
    this.profileDir = "fake-profile";
    this.launched = false;
    this.mode = null;
    this.conversationUrl = "https://chatgpt.com/";
    this.lastAssistantMessageId = null;
    this.lastAssistantTurn = null;
    this.responseNumber = 0;
    this.startConversationCalls = [];
    this.startConversationOptions = [];
    this.startConversationOutcome = null;
    this.sentAttachments = [];
    this.sentOutboundIds = [];
    this.targetId = "fake-target";
    this.lastUserMessageId = null;
    this.lastSendStatus = "not-submitted";
    this.conversationIdentityListener = null;
    this.pendingOutboundRecoverySupported = true;
    this.recoveryTargetCalls = [];
    this.reconciliationCalls = [];
    this.reconciliationOutcome = null;
    // Records window-state calls so tests can assert restore/minimize ordering.
    this.windowStateCalls = [];
  }

  async launch(preferredUrl = null, options = {}) {
    this.launched = true;
    this.lastLaunchUrl = preferredUrl;
    this.lastLaunchOptions = options;
  }

  supportsPendingOutboundRecovery() {
    return this.pendingOutboundRecoverySupported;
  }

  async launchRecoveryTarget(targetId) {
    this.launched = true;
    this.recoveryTargetCalls.push(targetId);
    if (!targetId || targetId !== this.targetId) {
      const error = new Error("The fake recovery target is unavailable.");
      error.code = "RECOVERY_TARGET_UNAVAILABLE";
      throw error;
    }
    return {
      conversationUrl: this.conversationUrl,
      targetId,
    };
  }

  async reconcilePendingOutbound(options = {}) {
    this.reconciliationCalls.push(options);
    const outcome = typeof this.reconciliationOutcome === "function"
      ? await this.reconciliationOutcome(options)
      : this.reconciliationOutcome;
    if (!outcome) {
      const error = new Error("The fake pending outbound remains uncertain.");
      error.code = "OUTBOUND_COMMIT_UNCERTAIN";
      throw error;
    }
    if (outcome.conversationUrl) {
      this.conversationUrl = outcome.conversationUrl;
    }
    if (outcome.conversationTargetId) {
      this.targetId = outcome.conversationTargetId;
    }
    this.lastUserMessageId = outcome.userMessageId ?? this.lastUserMessageId;
    if (outcome.status === "complete") {
      this.lastAssistantMessageId = outcome.assistantMessageId
        ?? this.lastAssistantMessageId;
      this.lastAssistantTurn = outcome.assistantTurn ?? this.lastAssistantTurn;
    }
    return outcome;
  }

  classifyConversationUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== "https://chatgpt.com") {
        return "invalid";
      }
      if (/^\/c\/WEB:/.test(url.pathname)) {
        return "provisional";
      }
      if (/^\/c\//.test(url.pathname)) {
        return "restorable";
      }
      return url.pathname === "/" ? "fresh" : "unknown";
    } catch {
      return "invalid";
    }
  }

  setConversationIdentityListener(listener) {
    this.conversationIdentityListener = listener;
  }

  getConversationIdentity() {
    return {
      conversationUrl: this.conversationUrl,
      targetId: this.targetId,
      kind: this.classifyConversationUrl(this.conversationUrl),
    };
  }

  getLastSendStatus() {
    return this.lastSendStatus;
  }

  async getLastUserMessageId() {
    return this.lastUserMessageId;
  }

  async close() {
    this.launched = false;
  }

  async restoreWindow() {
    this.windowStateCalls.push("restore");
  }

  async minimizeWindow() {
    this.windowStateCalls.push("minimize");
  }

  async getAuthState() {
    return "authenticated";
  }

  async waitForManualLogin() {}

  async startConversation(conversationUrl = null, options = {}) {
    this.startConversationCalls.push(conversationUrl);
    this.startConversationOptions.push(options);
    if (conversationUrl) {
      this.conversationUrl = conversationUrl;
    } else {
      this.conversationUrl = "https://chatgpt.com/";
    }
    const configuredOutcome = typeof this.startConversationOutcome === "function"
      ? await this.startConversationOutcome(conversationUrl, options)
      : this.startConversationOutcome;
    const isConversation = /^\/c\//.test(new URL(this.conversationUrl).pathname);
    const outcome = configuredOutcome ?? {
      status: isConversation ? "restored-existing" : "verified-fresh",
      conversationUrl: this.conversationUrl,
      targetId: this.targetId,
    };
    if (outcome.conversationUrl) {
      this.conversationUrl = outcome.conversationUrl;
    }
    return outcome;
  }

  async selectMode(mode) {
    this.mode = mode;
    return {
      status: "select",
      requested: mode,
      selectedLabel: mode,
      attempts: 1,
      reason: `Selecting ${mode}.`,
    };
  }

  async getConversationUrl() {
    return this.conversationUrl;
  }

  async sendMessage(text, { files = [], outboundId = null } = {}) {
    const priorUserMessageId = this.lastUserMessageId;
    const priorAssistantMessageId = this.lastAssistantMessageId;
    this.lastSendStatus = "commit-unknown";
    this.sentMessages.push(text);
    this.sentAttachments.push(files);
    this.sentOutboundIds.push(outboundId);
    if (this.conversationUrl === "https://chatgpt.com/") {
      this.conversationUrl = "https://chatgpt.com/c/fake";
    }
    this.lastSendStatus = "confirmed";
    this.lastUserMessageId = `user-${this.sentMessages.length}`;
    await this.conversationIdentityListener?.(this.getConversationIdentity());
    return {
      attachment: files.length ? { attached: files, failed: [] } : null,
      userMessageId: this.lastUserMessageId,
      userTurn: (this.sentMessages.length * 2) - 1,
      conversationUrl: this.conversationUrl,
      conversationTargetId: this.targetId,
      assistantBaseline: {
        ids: priorAssistantMessageId ? [priorAssistantMessageId] : [],
        count: priorAssistantMessageId ? 1 : 0,
        maxTurn: priorAssistantMessageId ? (this.responseNumber * 2) : null,
        lastText: "",
      },
      preOutboundMarkerIds: [
        priorUserMessageId,
        priorAssistantMessageId,
      ].filter(Boolean),
    };
  }

  async waitForTurnComplete({ onDelta } = {}) {
    if (this.responses.length === 0) {
      throw new Error("Fake adapter has no more responses.");
    }
    const response = this.responses.shift();
    this.responseNumber += 1;
    this.lastAssistantMessageId = `assistant-${this.responseNumber}`;
    this.lastAssistantTurn = this.responseNumber * 2;
    if (response instanceof Error) {
      throw response;
    }
    await onDelta?.(response);
    return response;
  }

  async getLastAssistantMessageId() {
    return this.lastAssistantMessageId;
  }

  async getLastAssistantTurn() {
    return this.lastAssistantTurn;
  }
}
