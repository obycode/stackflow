import { normalizeClosureEvent, parseUnsignedBigInt } from "./utils.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

function assertFunction(value, fieldName) {
  if (typeof value !== "function") {
    throw new Error(`${fieldName} must be a function`);
  }
  return value;
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function readField(record, names) {
  if (!record) {
    return null;
  }
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) {
      return record[name];
    }
  }
  return null;
}

function normalizeOptionalPrincipal(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    const principal = value.trim();
    return principal || null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  if (
    typeof record.type === "string" &&
    (record.type.toLowerCase() === "none" ||
      record.type.toLowerCase() === "optionalnone" ||
      record.type.toLowerCase() === "optional_none")
  ) {
    return null;
  }
  if (
    typeof record.type === "string" &&
    (record.type.toLowerCase() === "some" ||
      record.type.toLowerCase() === "optionalsome" ||
      record.type.toLowerCase() === "optional_some")
  ) {
    return normalizeOptionalPrincipal(record.value);
  }
  if (typeof record.value === "string") {
    return normalizeOptionalPrincipal(record.value);
  }
  if (typeof record.principal === "string") {
    return normalizeOptionalPrincipal(record.principal);
  }
  return null;
}

function toClosureFromPipeState({ trackedPipe, pipeState }) {
  const pipe = asRecord(pipeState);
  if (!pipe) {
    return null;
  }
  const closer = normalizeOptionalPrincipal(
    readField(pipe, ["closer", "closerPrincipal", "closingPrincipal"]),
  );
  if (!closer) {
    return null;
  }

  const nonceRaw = readField(pipe, ["nonce"]);
  const expiresAtRaw = readField(pipe, ["expires-at", "expiresAt"]);
  const balance1Raw = readField(pipe, ["balance-1", "balance1"]);
  const balance2Raw = readField(pipe, ["balance-2", "balance2"]);
  if (nonceRaw == null || expiresAtRaw == null || balance1Raw == null || balance2Raw == null) {
    return null;
  }

  const principal1 = trackedPipe.pipeKey?.["principal-1"];
  const closureMyBalance =
    principal1 && principal1 === trackedPipe.localPrincipal ? balance1Raw : balance2Raw;
  const eventNameRaw = readField(pipe, ["event", "eventName"]);
  const eventName =
    eventNameRaw === "force-cancel" || eventNameRaw === "force-close"
      ? eventNameRaw
      : "force-close";
  const blockHeightRaw = readField(pipe, ["block-height", "blockHeight"]);
  const txidRaw = readField(pipe, ["txid", "txId"]);
  const syntheticTxid = `readonly:${trackedPipe.pipeId}:${String(nonceRaw)}:${closer}`;

  return {
    contractId: trackedPipe.contractId,
    pipeKey: trackedPipe.pipeKey,
    eventName,
    nonce: String(nonceRaw),
    closer,
    txid: txidRaw == null ? syntheticTxid : String(txidRaw),
    blockHeight: blockHeightRaw == null ? "0" : String(blockHeightRaw),
    expiresAt: String(expiresAtRaw),
    closureMyBalance: String(closureMyBalance),
  };
}

function assertPositiveInt(value, fieldName) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

export class HourlyClosureWatcher {
  constructor({
    agentService,
    listClosureEvents = null,
    getPipeState = null,
    onError = null,
    intervalMs = DEFAULT_INTERVAL_MS,
    walletPassword = null,
  }) {
    if (!agentService) {
      throw new Error("agentService is required");
    }

    this.agentService = agentService;
    this.listClosureEvents =
      typeof listClosureEvents === "function" ? listClosureEvents : null;
    this.getPipeState = typeof getPipeState === "function" ? getPipeState : null;
    if (!this.listClosureEvents && !this.getPipeState) {
      throw new Error("listClosureEvents or getPipeState must be provided");
    }
    this.intervalMs = assertPositiveInt(intervalMs, "intervalMs");
    this.onError = typeof onError === "function" ? onError : null;
    this.walletPassword = walletPassword;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        if (this.onError) {
          this.onError(error);
        } else {
          console.error(
            `[stackflow-agent] watcher error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.getPipeState) {
      return this.runOnceByReadonlyPipe();
    }
    return this.runOnceByEvents();
  }

  async runOnceByReadonlyPipe() {
    if (this.running) {
      return {
        ok: true,
        skipped: true,
        reason: "already-running",
      };
    }

    this.running = true;
    try {
      const trackedPipes = this.agentService.getTrackedPipes();
      if (!Array.isArray(trackedPipes) || trackedPipes.length === 0) {
        return {
          ok: true,
          mode: "readonly-pipe",
          pipesScanned: 0,
          closuresFound: 0,
          disputesSubmitted: 0,
        };
      }

      let closuresFound = 0;
      let disputesSubmitted = 0;
      let skippedAlreadyDisputed = 0;
      let pipesScanned = 0;
      for (const trackedPipe of trackedPipes) {
        pipesScanned += 1;
        const pipeState = await this.getPipeState({
          contractId: trackedPipe.contractId,
          token: trackedPipe.token ?? null,
          pipeKey: trackedPipe.pipeKey,
          forPrincipal: trackedPipe.localPrincipal,
          withPrincipal: trackedPipe.counterpartyPrincipal,
          pipeId: trackedPipe.pipeId,
        });
        const rawClosure = toClosureFromPipeState({
          trackedPipe,
          pipeState,
        });
        if (!rawClosure) {
          continue;
        }
        let closure;
        try {
          closure = normalizeClosureEvent(rawClosure);
        } catch {
          continue;
        }

        closuresFound += 1;
        const existingClosure = this.agentService.stateStore.getClosure(closure.txid);
        this.agentService.stateStore.recordClosure(closure);
        if (existingClosure?.disputed) {
          skippedAlreadyDisputed += 1;
          continue;
        }

        const disputeResult = await this.agentService.disputeClosure({
          closureEvent: closure,
          walletPassword: this.walletPassword,
        });
        if (disputeResult.submitted) {
          disputesSubmitted += 1;
        }
      }

      return {
        ok: true,
        mode: "readonly-pipe",
        pipesScanned,
        closuresFound,
        disputesSubmitted,
        skippedAlreadyDisputed,
      };
    } finally {
      this.running = false;
    }
  }

  async runOnceByEvents() {
    if (this.running) {
      return {
        ok: true,
        skipped: true,
        reason: "already-running",
      };
    }

    this.running = true;
    try {
      const fromBlockHeight = this.agentService.stateStore.getWatcherCursor();
      const events = await this.listClosureEvents({
        fromBlockHeight,
      });
      if (!Array.isArray(events) || events.length === 0) {
        return {
          ok: true,
          scanned: 0,
          disputesSubmitted: 0,
          fromBlockHeight,
          toBlockHeight: fromBlockHeight,
        };
      }

      let highestBlock = parseUnsignedBigInt(fromBlockHeight, "fromBlockHeight");
      let disputesSubmitted = 0;
      let skippedAlreadyDisputed = 0;
      let scanned = 0;

      for (const rawEvent of events) {
        let closure;
        try {
          closure = normalizeClosureEvent(rawEvent);
        } catch {
          continue;
        }
        scanned += 1;
        const existingClosure = this.agentService.stateStore.getClosure(closure.txid);
        this.agentService.stateStore.recordClosure(closure);
        if (existingClosure?.disputed) {
          skippedAlreadyDisputed += 1;
        } else {
          const disputeResult = await this.agentService.disputeClosure({
            closureEvent: closure,
            walletPassword: this.walletPassword,
          });
          if (disputeResult.submitted) {
            disputesSubmitted += 1;
          }
        }

        const block = parseUnsignedBigInt(closure.blockHeight, "blockHeight");
        if (block > highestBlock) {
          highestBlock = block;
        }
      }

      this.agentService.stateStore.setWatcherCursor(highestBlock.toString(10));
      return {
        ok: true,
        scanned,
        disputesSubmitted,
        skippedAlreadyDisputed,
        fromBlockHeight,
        toBlockHeight: highestBlock.toString(10),
      };
    } finally {
      this.running = false;
    }
  }
}
