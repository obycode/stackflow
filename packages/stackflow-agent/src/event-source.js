import { normalizeClosureEvent } from "./utils.js";

function assertNonEmptyString(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} must be non-empty`);
  }
  return text;
}

function assertFunction(value, fieldName) {
  if (typeof value !== "function") {
    throw new Error(`${fieldName} must be a function`);
  }
  return value;
}

export class AibtcClosureEventSource {
  constructor({
    walletAdapter,
    contractId,
    network = "devnet",
    decodeEvent,
  }) {
    if (!walletAdapter || typeof walletAdapter.getContractEvents !== "function") {
      throw new Error("walletAdapter.getContractEvents is required");
    }
    this.walletAdapter = walletAdapter;
    this.contractId = assertNonEmptyString(contractId, "contractId");
    this.network = String(network || "devnet").trim();
    this.decodeEvent = assertFunction(decodeEvent, "decodeEvent");
  }

  async listClosureEvents({
    fromBlockHeight,
    toBlockHeight = null,
    pageSize = 200,
    maxPages = 10,
  }) {
    const closures = [];
    let offset = 0;
    let pages = 0;

    while (pages < maxPages) {
      const page = await this.walletAdapter.getContractEvents({
        contractId: this.contractId,
        fromHeight: fromBlockHeight,
        toHeight: toBlockHeight,
        limit: pageSize,
        offset,
        network: this.network,
      });
      const events = Array.isArray(page.events) ? page.events : [];
      if (events.length === 0) {
        break;
      }

      for (const event of events) {
        const decoded = this.decodeEvent(event);
        if (!decoded) {
          continue;
        }
        try {
          const closure = normalizeClosureEvent(decoded);
          closures.push(closure);
        } catch {
          // Ignore malformed/non-closure events.
        }
      }

      if (events.length < pageSize) {
        break;
      }
      offset += pageSize;
      pages += 1;
    }

    return closures;
  }
}
