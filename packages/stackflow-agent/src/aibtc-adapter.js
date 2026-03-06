import { buildDisputeCallInput } from "./utils.js";

function assertFunction(value, fieldName) {
  if (typeof value !== "function") {
    throw new Error(`${fieldName} must be a function`);
  }
  return value;
}

function assertNonEmptyString(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} must be non-empty`);
  }
  return text;
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function parseReadOnlyError(result) {
  const record = asRecord(result);
  if (!record) {
    return null;
  }
  const kind = typeof record.type === "string" ? record.type.toLowerCase() : null;
  if (kind === "responseerr" || kind === "response_err" || kind === "err") {
    return `readonly call returned error response`;
  }
  return null;
}

function unwrapReadonlyValue(input) {
  if (input == null) {
    return null;
  }
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((entry) => unwrapReadonlyValue(entry));
  }
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const kind = typeof record.type === "string" ? record.type.toLowerCase() : null;
  if (kind === "responseok" || kind === "response_ok" || kind === "ok") {
    return unwrapReadonlyValue(record.value);
  }
  if (kind === "responseerr" || kind === "response_err" || kind === "err") {
    throw new Error("readonly call returned error response");
  }
  if (kind === "none" || kind === "optionalnone" || kind === "optional_none") {
    return null;
  }
  if (kind === "some" || kind === "optionalsome" || kind === "optional_some") {
    return unwrapReadonlyValue(record.value);
  }
  if (kind === "uint" || kind === "int") {
    return String(record.value ?? "");
  }
  if (kind === "tuple" && record.value && typeof record.value === "object") {
    return unwrapReadonlyValue(record.value);
  }

  if (Object.prototype.hasOwnProperty.call(record, "value")) {
    return unwrapReadonlyValue(record.value);
  }

  const output = {};
  for (const [key, value] of Object.entries(record)) {
    output[key] = unwrapReadonlyValue(value);
  }
  return output;
}

function extractPipePayload(rawResult) {
  const record = asRecord(rawResult);
  if (!record) {
    return null;
  }

  const direct = unwrapReadonlyValue(rawResult);
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const directRecord = direct;
    if (
      Object.prototype.hasOwnProperty.call(directRecord, "balance-1") ||
      Object.prototype.hasOwnProperty.call(directRecord, "balance1")
    ) {
      return directRecord;
    }
  }

  const candidates = [
    record.pipe,
    record.value,
    record.result,
    record.data,
    asRecord(record.data)?.pipe,
    asRecord(record.data)?.value,
    asRecord(record.data)?.result,
  ];

  for (const candidate of candidates) {
    const parsed = unwrapReadonlyValue(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    if (
      Object.prototype.hasOwnProperty.call(parsed, "balance-1") ||
      Object.prototype.hasOwnProperty.call(parsed, "balance1")
    ) {
      return parsed;
    }
  }
  return null;
}

function isMissingToolError(error) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("unknown tool") ||
    message.includes("tool not found") ||
    message.includes("not found") ||
    message.includes("no such tool")
  );
}

function normalizeToolResult(result, toolName) {
  if (!result || typeof result !== "object") {
    throw new Error(`${toolName} returned an invalid response`);
  }
  return result;
}

function shouldRetrySip018WithDomain(error) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("domain") &&
    (message.includes("required") || message.includes("missing") || message.includes("must"))
  );
}

function shouldRetrySip018Legacy(error) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("domain") ||
    message.includes("contract") ||
    message.includes("input validation") ||
    message.includes("invalid arguments")
  );
}

function deriveSip018Domain(contract) {
  const contractText = String(contract ?? "").trim();
  if (!contractText) {
    return { name: "stackflow", version: "1.0.0" };
  }

  // The Clarity contract defines its domain as:
  //   { name: (to-ascii? current-contract), version: "0.6.0", chain-id: chain-id }
  // `current-contract` serializes as the full principal: "SP....contract-name".
  // Use the full contractId as the domain name to match on-chain verification.
  const [, contractName = contractText] = contractText.split(".");
  const versionMatch = contractName.match(/(\d+)-(\d+)-(\d+)$/);
  const version = versionMatch
    ? `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}`
    : "1.0.0";

  return { name: contractText, version };
}

export class AibtcWalletAdapter {
  constructor({
    invokeTool,
    readonlyToolName = null,
  }) {
    this.invokeTool = assertFunction(invokeTool, "invokeTool");
    this.readonlyToolName =
      readonlyToolName == null ? null : assertNonEmptyString(readonlyToolName, "readonlyToolName");
  }

  async sip018Sign({
    contract,
    message,
    walletPassword = null,
  }) {
    const domainArgs = {
      message,
      domain: deriveSip018Domain(contract),
      wallet_password: walletPassword ?? undefined,
    };

    const legacyArgs = {
      contract,
      message,
      wallet_password: walletPassword ?? undefined,
    };

    let result;
    try {
      result = normalizeToolResult(
        await this.invokeTool("sip018_sign", domainArgs),
        "sip018_sign",
      );
    } catch (error) {
      if (!shouldRetrySip018Legacy(error)) {
        throw error;
      }
      result = normalizeToolResult(
        await this.invokeTool("sip018_sign", legacyArgs),
        "sip018_sign",
      );
    }

    const signature = result.signature ?? result.data?.signature ?? null;
    if (typeof signature !== "string" || !signature.trim()) {
      throw new Error("sip018_sign did not return a signature");
    }
    return signature;
  }

  async callContract({
    contractId,
    functionName,
    functionArgs,
    network = null,
    walletPassword = null,
    postConditions = null,
    postConditionMode = null,
  }) {
    const [contractAddress, contractName] = String(contractId).split(".");
    if (!contractAddress || !contractName) {
      throw new Error("contractId must be <address>.<name>");
    }

    const result = normalizeToolResult(
      await this.invokeTool("call_contract", {
        contractAddress,
        contractName,
        functionName,
        functionArgs,
        network: network ?? undefined,
        wallet_password: walletPassword ?? undefined,
        postConditions: postConditions ?? undefined,
        postConditionMode: postConditionMode ?? undefined,
      }),
      "call_contract",
    );

    return result;
  }

  async submitDispute({
    closureEvent,
    signatureState,
    network = null,
    walletPassword = null,
  }) {
    const disputeInput = buildDisputeCallInput({
      closureEvent,
      signatureState,
    });
    return this.callContract({
      contractId: disputeInput.contractId,
      functionName: disputeInput.functionName,
      functionArgs: disputeInput.functionArgs,
      network,
      walletPassword,
      postConditionMode: "allow",
    });
  }

  async getContractEvents({
    contractId,
    fromHeight = null,
    toHeight = null,
    limit = 200,
    offset = 0,
    network = null,
  }) {
    const result = normalizeToolResult(
      await this.invokeTool("get_contract_events", {
        contract_id: contractId,
        from_height: fromHeight ?? undefined,
        to_height: toHeight ?? undefined,
        limit,
        offset,
        network: network ?? undefined,
      }),
      "get_contract_events",
    );

    const events = Array.isArray(result.events)
      ? result.events
      : Array.isArray(result.data?.events)
        ? result.data.events
        : [];

    return {
      events,
      nextOffset:
        typeof result.nextOffset === "number"
          ? result.nextOffset
          : typeof result.data?.nextOffset === "number"
            ? result.data.nextOffset
            : null,
    };
  }

  async callReadonly({
    contractId,
    functionName,
    functionArgs,
    sender,
    network = null,
  }) {
    const [contractAddress, contractName] = String(contractId).split(".");
    if (!contractAddress || !contractName) {
      throw new Error("contractId must be <address>.<name>");
    }
    const senderPrincipal = assertNonEmptyString(sender, "sender");
    const toolArgs = {
      contractAddress,
      contractName,
      functionName: assertNonEmptyString(functionName, "functionName"),
      functionArgs: Array.isArray(functionArgs) ? functionArgs : [],
      sender: senderPrincipal,
      sender_address: senderPrincipal,
      network: network ?? undefined,
    };

    if (this.readonlyToolName) {
      const direct = normalizeToolResult(
        await this.invokeTool(this.readonlyToolName, toolArgs),
        this.readonlyToolName,
      );
      const readOnlyError = parseReadOnlyError(direct);
      if (readOnlyError) {
        throw new Error(readOnlyError);
      }
      return direct;
    }

    const toolNames = [
      "call_readonly",
      "call_read_only",
      "call_readonly_function",
      "call_read_only_function",
      "call_contract_readonly",
      "call_contract_read_only",
    ];
    let lastError = null;
    for (const toolName of toolNames) {
      try {
        const result = normalizeToolResult(
          await this.invokeTool(toolName, toolArgs),
          toolName,
        );
        const readOnlyError = parseReadOnlyError(result);
        if (readOnlyError) {
          throw new Error(readOnlyError);
        }
        return result;
      } catch (error) {
        lastError = error;
        if (!isMissingToolError(error)) {
          throw error;
        }
      }
    }

    throw new Error(
      `no supported readonly tool found; tried ${toolNames.join(", ")}${
        lastError ? ` (${String(lastError)})` : ""
      }`,
    );
  }

  async getPipe({
    contractId,
    token = null,
    forPrincipal,
    withPrincipal,
    network = null,
  }) {
    const result = await this.callReadonly({
      contractId,
      functionName: "get-pipe",
      functionArgs: [token, assertNonEmptyString(withPrincipal, "withPrincipal")],
      sender: assertNonEmptyString(forPrincipal, "forPrincipal"),
      network,
    });
    return extractPipePayload(result);
  }
}
