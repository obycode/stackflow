function assertObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
}

function assertNonEmptyString(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return text;
}

export function parseUnsignedBigInt(value, fieldName = "value") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`${fieldName} must be an unsigned integer string`);
  }
  return BigInt(text);
}

export function toUnsignedString(value, fieldName = "value") {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new Error(`${fieldName} must be non-negative`);
    }
    return value.toString(10);
  }
  return parseUnsignedBigInt(value, fieldName).toString(10);
}

export function normalizeHex(value, fieldName = "value") {
  const text = String(value ?? "").trim().toLowerCase();
  const normalized = text.startsWith("0x") ? text : `0x${text}`;
  if (!/^0x[0-9a-f]+$/.test(normalized)) {
    throw new Error(`${fieldName} must be hex`);
  }
  return normalized;
}

export function buildPipeId({ contractId, pipeKey }) {
  const contract = assertNonEmptyString(contractId, "contractId");
  assertObject(pipeKey, "pipeKey");
  const principal1 = assertNonEmptyString(pipeKey["principal-1"], "pipeKey.principal-1");
  const principal2 = assertNonEmptyString(pipeKey["principal-2"], "pipeKey.principal-2");
  const token = pipeKey.token ? String(pipeKey.token).trim() : "stx";
  return `${contract}|${token}|${principal1}|${principal2}`;
}

export function normalizeClosureEvent(event) {
  assertObject(event, "closure event");
  const eventName = assertNonEmptyString(event.eventName, "eventName");
  if (eventName !== "force-cancel" && eventName !== "force-close") {
    throw new Error("closure event must be force-cancel or force-close");
  }

  const contractId = assertNonEmptyString(event.contractId, "contractId");
  assertObject(event.pipeKey, "pipeKey");
  const pipeId = buildPipeId({
    contractId,
    pipeKey: event.pipeKey,
  });

  const nonce = toUnsignedString(event.nonce ?? event.pipeNonce ?? "0", "nonce");
  const closer = assertNonEmptyString(event.closer, "closer");
  const txid = assertNonEmptyString(event.txid, "txid");
  const blockHeight = toUnsignedString(event.blockHeight, "blockHeight");
  const expiresAt = toUnsignedString(event.expiresAt, "expiresAt");
  const closureMyBalance =
    event.closureMyBalance == null
      ? null
      : toUnsignedString(event.closureMyBalance, "closureMyBalance");

  return {
    contractId,
    pipeId,
    pipeKey: event.pipeKey,
    eventName,
    nonce,
    closer,
    txid,
    blockHeight,
    expiresAt,
    closureMyBalance,
  };
}

export function normalizeSignatureState(input) {
  assertObject(input, "signature state");
  const contractId = assertNonEmptyString(input.contractId, "contractId");
  assertObject(input.pipeKey, "pipeKey");
  const pipeId = buildPipeId({
    contractId,
    pipeKey: input.pipeKey,
  });
  return {
    contractId,
    pipeId,
    pipeKey: input.pipeKey,
    forPrincipal: assertNonEmptyString(input.forPrincipal, "forPrincipal"),
    withPrincipal: assertNonEmptyString(input.withPrincipal, "withPrincipal"),
    token: input.token ? String(input.token).trim() : null,
    myBalance: toUnsignedString(input.myBalance, "myBalance"),
    theirBalance: toUnsignedString(input.theirBalance, "theirBalance"),
    nonce: toUnsignedString(input.nonce, "nonce"),
    action: toUnsignedString(input.action ?? "1", "action"),
    actor: assertNonEmptyString(input.actor, "actor"),
    mySignature: normalizeHex(input.mySignature, "mySignature"),
    theirSignature: normalizeHex(input.theirSignature, "theirSignature"),
    secret: input.secret == null ? null : normalizeHex(input.secret, "secret"),
    validAfter:
      input.validAfter == null ? null : toUnsignedString(input.validAfter, "validAfter"),
    beneficialOnly: input.beneficialOnly === true,
    updatedAt: input.updatedAt ? String(input.updatedAt) : new Date().toISOString(),
  };
}

export function isDisputeBeneficial({ closureEvent, signatureState, onlyBeneficial }) {
  if (!closureEvent || !signatureState) {
    return false;
  }

  const closureNonce = parseUnsignedBigInt(closureEvent.nonce, "closure nonce");
  const stateNonce = parseUnsignedBigInt(signatureState.nonce, "state nonce");
  if (stateNonce <= closureNonce) {
    return false;
  }

  if (!onlyBeneficial && !signatureState.beneficialOnly) {
    return true;
  }

  if (closureEvent.closer === signatureState.forPrincipal) {
    return false;
  }

  if (closureEvent.eventName === "force-cancel") {
    return parseUnsignedBigInt(signatureState.myBalance, "myBalance") > 0n;
  }

  if (!closureEvent.closureMyBalance) {
    return true;
  }

  const closureBalance = parseUnsignedBigInt(
    closureEvent.closureMyBalance,
    "closureMyBalance",
  );
  const stateBalance = parseUnsignedBigInt(signatureState.myBalance, "myBalance");
  return stateBalance > closureBalance;
}

export function buildDisputeCallInput({ closureEvent, signatureState }) {
  if (!closureEvent || !signatureState) {
    throw new Error("closureEvent and signatureState are required");
  }

  return {
    contractId: closureEvent.contractId,
    functionName: "dispute-closure-for",
    functionArgs: [
      signatureState.forPrincipal,
      signatureState.token,
      signatureState.withPrincipal,
      signatureState.myBalance,
      signatureState.theirBalance,
      signatureState.mySignature,
      signatureState.theirSignature,
      signatureState.nonce,
      signatureState.action,
      signatureState.actor,
      signatureState.secret,
      signatureState.validAfter,
    ],
  };
}
