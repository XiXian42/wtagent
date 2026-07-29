export class WTAgentError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.code = options.code ?? "WTAGENT_ERROR";
    this.recoverable = options.recoverable ?? false;
    this.details = options.details;
  }
}

export class ProtocolError extends WTAgentError {
  constructor(message, options = {}) {
    super(message, {
      code: "PROTOCOL_ERROR",
      recoverable: true,
      ...options,
    });
  }
}

export class BrowserAdapterError extends WTAgentError {
  constructor(message, options = {}) {
    super(message, {
      code: "BROWSER_ADAPTER_ERROR",
      recoverable: true,
      ...options,
    });
  }
}

export class ToolValidationError extends WTAgentError {
  constructor(message, options = {}) {
    super(message, {
      code: "TOOL_VALIDATION_ERROR",
      recoverable: true,
      ...options,
    });
  }
}

export class PolicyDeniedError extends WTAgentError {
  constructor(message, options = {}) {
    super(message, {
      code: "POLICY_DENIED",
      recoverable: true,
      ...options,
    });
  }
}

// Compatibility alias for integrations written before the product rename.
export { WTAgentError as WebAgentError };
