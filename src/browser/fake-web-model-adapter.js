export class FakeWebModelAdapter {
  constructor(responses = []) {
    this.responses = [...responses];
    this.sentMessages = [];
    this.profileDir = "fake-profile";
    this.launched = false;
    this.mode = null;
    this.conversationUrl = "https://chatgpt.com/";
    this.lastAssistantMessageId = null;
    this.responseNumber = 0;
    this.startConversationCalls = [];
    this.sentAttachments = [];
  }

  async launch() {
    this.launched = true;
  }

  async close() {
    this.launched = false;
  }

  async getAuthState() {
    return "authenticated";
  }

  async waitForManualLogin() {}

  async startConversation(conversationUrl = null) {
    this.startConversationCalls.push(conversationUrl);
    if (conversationUrl) {
      this.conversationUrl = conversationUrl;
    } else {
      this.conversationUrl = "https://chatgpt.com/";
    }
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

  async sendMessage(text, { files = [] } = {}) {
    this.sentMessages.push(text);
    this.sentAttachments.push(files);
    if (this.conversationUrl === "https://chatgpt.com/") {
      this.conversationUrl = "https://chatgpt.com/c/fake";
    }
    return { attachment: files.length ? { attached: files, failed: [] } : null };
  }

  async waitForTurnComplete({ onDelta } = {}) {
    if (this.responses.length === 0) {
      throw new Error("Fake adapter has no more responses.");
    }
    const response = this.responses.shift();
    this.responseNumber += 1;
    this.lastAssistantMessageId = `assistant-${this.responseNumber}`;
    await onDelta?.(response);
    return response;
  }

  async getLastAssistantMessageId() {
    return this.lastAssistantMessageId;
  }
}
