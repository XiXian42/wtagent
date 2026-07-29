import { ToolValidationError } from "../shared/errors.js";

export class ToolRegistry {
  #definitions = new Map();

  register(definition) {
    if (!definition?.name || typeof definition.execute !== "function") {
      throw new Error("Tool definition requires name and execute.");
    }
    if (this.#definitions.has(definition.name)) {
      throw new Error(`Duplicate tool: ${definition.name}`);
    }
    this.#definitions.set(definition.name, definition);
    return this;
  }

  list() {
    return [...this.#definitions.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputDescription: definition.inputDescription,
      risk: definition.risk ?? "execute",
    }));
  }

  validate(toolCall) {
    const definition = this.#definitions.get(toolCall.name);
    if (!definition) {
      throw new ToolValidationError(`Unknown tool: ${toolCall.name}`);
    }

    const result = definition.inputSchema.safeParse(toolCall.args ?? {});
    if (!result.success) {
      throw new ToolValidationError(
        `Invalid arguments for ${toolCall.name}: ${result.error.message}`,
        { details: result.error.issues },
      );
    }

    return {
      ...toolCall,
      args: result.data,
      definition,
    };
  }

  async execute(preparedCall, context) {
    const execution = Promise.resolve().then(
      () => preparedCall.definition.execute(preparedCall.args, context),
    );
    const timeoutMs = preparedCall.definition.managesTimeout
      ? null
      : Number(context.toolTimeoutMs);
    let timer = null;

    try {
      let outcome;
      if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
        outcome = await Promise.race([
          execution.then(
            (result) => ({ type: "result", result }),
            (error) => ({ type: "error", error }),
          ),
          new Promise((resolve) => {
            timer = setTimeout(
              () => resolve({ type: "timeout" }),
              timeoutMs,
            );
            timer.unref?.();
          }),
        ]);
      } else {
        outcome = await execution.then(
          (result) => ({ type: "result", result }),
          (error) => ({ type: "error", error }),
        );
      }

      if (outcome.type === "timeout") {
        execution.catch(() => undefined);
        const completionUnknown = preparedCall.definition.risk !== "read";
        return {
          callId: preparedCall.id,
          name: preparedCall.name,
          ok: false,
          message: completionUnknown
            ? (
              `Tool exceeded the ${timeoutMs}ms runtime guard. `
              + "The operation may still complete because it does not support "
              + "hard cancellation; completion is unknown."
            )
            : `Tool exceeded the ${timeoutMs}ms runtime guard.`,
          meta: {
            timedOut: true,
            completionUnknown,
            recoverable: true,
          },
        };
      }

      if (outcome.type === "error") {
        throw outcome.error;
      }

      const result = outcome.result;
      return {
        callId: preparedCall.id,
        name: preparedCall.name,
        ok: Boolean(result.ok),
        message: result.message ?? "",
        data: result.data,
        stdout: result.stdout,
        stderr: result.stderr,
        meta: result.meta,
      };
    } catch (error) {
      return {
        callId: preparedCall.id,
        name: preparedCall.name,
        ok: false,
        message: error.message,
        stderr: error.stack,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

