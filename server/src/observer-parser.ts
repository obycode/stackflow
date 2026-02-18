import { cvToJSON, deserializeCV } from "@stacks/transactions";

import type {
  PipeKey,
  PipePendingSnapshot,
  PipeSnapshot,
  StackflowPrintEvent,
} from "./types.js";

const DEFAULT_STACKFLOW_CONTRACT_PATTERN = /\.stackflow(?:[-.].+)?$/i;

interface CandidateContractEvent {
  envelope: Record<string, unknown>;
  event: Record<string, unknown>;
}

interface ExtractOptions {
  watchedContracts?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHexLikeString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }

  if (trimmed.startsWith("0x")) {
    return /^[0-9a-fA-F]+$/.test(trimmed.slice(2));
  }

  return /^[0-9a-fA-F]+$/.test(trimmed);
}

function getFirstScalarString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }

    if (typeof value === "bigint") {
      return value.toString(10);
    }
  }
  return null;
}

function unwrapClarityJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(unwrapClarityJson);
  }

  if (!isRecord(value)) {
    return value;
  }

  const keys = Object.keys(value);
  if (keys.length === 2 && keys.includes("type") && keys.includes("value")) {
    const type = String(value.type);
    const rawValue = value.value;

    if (type === "uint" || type === "int") {
      return String(rawValue);
    }

    return unwrapClarityJson(rawValue);
  }

  const unwrapped: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    unwrapped[key] = unwrapClarityJson(nestedValue);
  }

  return unwrapped;
}

function extractHexValue(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!isHexLikeString(trimmed)) {
      return null;
    }
    return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  }

  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.hex === "string") {
    return value.hex.startsWith("0x") ? value.hex : `0x${value.hex}`;
  }

  if (typeof value.value === "string") {
    return value.value.startsWith("0x") ? value.value : `0x${value.value}`;
  }

  return null;
}

function decodePrintValue(
  ...values: unknown[]
): Record<string, unknown> | null {
  let hex: string | null = null;

  for (const value of values) {
    if (!hex) {
      hex = extractHexValue(value);
    }
    if (hex) {
      break;
    }
  }

  if (!hex) {
    return null;
  }

  try {
    const decoded = unwrapClarityJson(cvToJSON(deserializeCV(hex)));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function normalizePipeKey(pipeKey: unknown): PipeKey | null {
  if (!isRecord(pipeKey)) {
    return null;
  }

  const principal1 = pipeKey["principal-1"];
  const principal2 = pipeKey["principal-2"];

  if (typeof principal1 !== "string" || typeof principal2 !== "string") {
    return null;
  }

  return {
    "principal-1": principal1,
    "principal-2": principal2,
    token: typeof pipeKey.token === "string" ? pipeKey.token : null,
  };
}

function normalizePipe(pipe: unknown): PipeSnapshot | null {
  if (!isRecord(pipe)) {
    return null;
  }

  const normalizePending = (value: unknown): PipePendingSnapshot | null => {
    if (!isRecord(value)) {
      return null;
    }

    return {
      amount: typeof value.amount === "string" ? value.amount : null,
      "burn-height":
        typeof value["burn-height"] === "string" ? value["burn-height"] : null,
    };
  };

  return {
    "balance-1":
      typeof pipe["balance-1"] === "string" ? pipe["balance-1"] : null,
    "balance-2":
      typeof pipe["balance-2"] === "string" ? pipe["balance-2"] : null,
    "pending-1": normalizePending(pipe["pending-1"]),
    "pending-2": normalizePending(pipe["pending-2"]),
    "expires-at":
      typeof pipe["expires-at"] === "string" ? pipe["expires-at"] : null,
    nonce: typeof pipe.nonce === "string" ? pipe.nonce : null,
    closer: typeof pipe.closer === "string" ? pipe.closer : null,
  };
}

function collectContractEventCandidates(
  payload: unknown,
): CandidateContractEvent[] {
  const queue: unknown[] = [payload];
  const visited = new Set<object>();
  const candidates: CandidateContractEvent[] = [];

  while (queue.length > 0) {
    const current = queue.shift();

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    if (!isRecord(current)) {
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (isRecord(current.contract_event)) {
      candidates.push({ envelope: current, event: current.contract_event });
    }

    if (isRecord(current.contract_log)) {
      candidates.push({ envelope: current, event: current.contract_log });
    }

    if (
      typeof current.contract_identifier === "string" &&
      typeof current.topic === "string" &&
      current.raw_value !== undefined &&
      (current.txid !== undefined ||
        current.tx_id !== undefined ||
        current.event_index !== undefined ||
        current.eventIndex !== undefined)
    ) {
      candidates.push({ envelope: current, event: current });
    }

    for (const value of Object.values(current)) {
      queue.push(value);
    }
  }

  return candidates;
}

function contractMatches(
  contractId: string | null,
  watchedContracts: string[],
): boolean {
  if (!contractId) {
    return false;
  }

  if (watchedContracts.length > 0) {
    return watchedContracts.includes(contractId);
  }

  return DEFAULT_STACKFLOW_CONTRACT_PATTERN.test(contractId);
}

function normalizeContractEvent(
  payload: unknown,
  candidate: CandidateContractEvent,
  watchedContracts: string[],
): StackflowPrintEvent | null {
  const { envelope, event } = candidate;

  const contractId = getFirstScalarString(
    event.contract_identifier,
    event.contract_id,
    event.contractId,
    envelope.contract_identifier,
    envelope.contract_id,
  );

  if (!contractId || !contractMatches(contractId, watchedContracts)) {
    return null;
  }

  const topic = getFirstScalarString(event.topic, envelope.topic);
  if (topic !== "print") {
    return null;
  }

  const payloadRecord = isRecord(payload) ? payload : {};

  const txid = getFirstScalarString(
    event.txid,
    event.tx_id,
    envelope.txid,
    envelope.tx_id,
  );
  const blockHeight = getFirstScalarString(
    event.block_height,
    event.blockHeight,
    envelope.block_height,
    envelope.blockHeight,
    payloadRecord.block_height,
    payloadRecord.blockHeight,
  );
  const blockHash = getFirstScalarString(
    event.block_hash,
    event.blockHash,
    envelope.block_hash,
    envelope.blockHash,
    payloadRecord.block_hash,
    payloadRecord.blockHash,
  );
  const eventIndex = getFirstScalarString(
    event.event_index,
    event.eventIndex,
    envelope.event_index,
    envelope.eventIndex,
  );

  const decoded = decodePrintValue(
    event.raw_value,
    event.rawValue,
    envelope.raw_value,
    envelope.rawValue,
  );
  const eventName =
    getFirstScalarString(
      decoded && typeof decoded.event === "string" ? decoded.event : null,
      event.event_name,
      event.eventName,
    ) || null;

  return {
    contractId,
    topic: "print",
    txid,
    blockHeight,
    blockHash,
    eventIndex,
    eventName,
    sender:
      getFirstScalarString(
        decoded && typeof decoded.sender === "string" ? decoded.sender : null,
        event.sender,
        envelope.sender,
      ) || null,
    pipeKey: normalizePipeKey(
      (decoded ? decoded["pipe-key"] : null) ??
        event["pipe-key"] ??
        envelope["pipe-key"],
    ),
    pipe: normalizePipe(
      (decoded ? decoded.pipe : null) ?? event.pipe ?? envelope.pipe,
    ),
    repr: null,
  };
}

function dedupeEvents(events: StackflowPrintEvent[]): StackflowPrintEvent[] {
  const seen = new Set<string>();
  const output: StackflowPrintEvent[] = [];

  for (const event of events) {
    const dedupeKey = [
      event.txid,
      event.eventIndex,
      event.contractId,
      event.eventName,
      event.sender,
      event.pipeKey ? normalizePipeId(event.pipeKey) : null,
    ].join("|");

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    output.push(event);
  }

  return output;
}

export function normalizePipeId(pipeKey: PipeKey | null): string | null {
  if (!pipeKey) {
    return null;
  }

  const token = pipeKey.token || "stx";
  return `${token}|${pipeKey["principal-1"]}|${pipeKey["principal-2"]}`;
}

export function extractStackflowPrintEvents(
  payload: unknown,
  options: ExtractOptions = {},
): StackflowPrintEvent[] {
  const watchedContracts = options.watchedContracts || [];
  const candidates = collectContractEventCandidates(payload);

  const normalized = candidates
    .map((candidate) =>
      normalizeContractEvent(payload, candidate, watchedContracts),
    )
    .filter((event): event is StackflowPrintEvent => event !== null);

  return dedupeEvents(normalized);
}
