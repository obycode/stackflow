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

  reportError(error, context = null) {
    if (!error) {
      return;
    }
    if (this.onError) {
      if (context && error instanceof Error && !error.context) {
        error.context = context;
      }
      this.onError(error);
      return;
    }
    console.error(
      `[stackflow-agent] watcher error${
        context ? ` (${context})` : ""
      }: ${error instanceof Error ? error.message : String(error)}`,
    );
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
          skippedAlreadyDisputed: 0,
          fetchErrors: 0,
          disputeErrors: 0,
        };
      }

      let closuresFound = 0;
      let disputesSubmitted = 0;
      let skippedAlreadyDisputed = 0;
      let fetchErrors = 0;
      let disputeErrors = 0;
      let pipesScanned = 0;
      for (const trackedPipe of trackedPipes) {
        pipesScanned += 1;
        let pipeState;
        try {
          pipeState = await this.getPipeState({
            contractId: trackedPipe.contractId,
            token: trackedPipe.token ?? null,
            pipeKey: trackedPipe.pipeKey,
            forPrincipal: trackedPipe.localPrincipal,
            withPrincipal: trackedPipe.counterpartyPrincipal,
            pipeId: trackedPipe.pipeId,
          });
        } catch (error) {
          fetchErrors += 1;
          this.reportError(
            error,
            `getPipeState:${trackedPipe.contractId}:${trackedPipe.pipeId}`,
          );
          continue;
        }
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

        let disputeResult;
        try {
          disputeResult = await this.agentService.disputeClosure({
            closureEvent: closure,
            walletPassword: this.walletPassword,
          });
        } catch (error) {
          disputeErrors += 1;
          this.reportError(error, `disputeClosure:${closure.txid}`);
          continue;
        }
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
        fetchErrors,
        disputeErrors,
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
      let events;
      try {
        events = await this.listClosureEvents({
          fromBlockHeight,
        });
      } catch (error) {
        this.reportError(error, "listClosureEvents");
        return {
          ok: false,
          scanned: 0,
          invalidEvents: 0,
          disputesSubmitted: 0,
          skippedAlreadyDisputed: 0,
          disputeErrors: 0,
          listErrors: 1,
          fromBlockHeight,
          toBlockHeight: fromBlockHeight,
        };
      }
      if (!Array.isArray(events) || events.length === 0) {
        return {
          ok: true,
          scanned: 0,
          invalidEvents: 0,
          disputesSubmitted: 0,
          skippedAlreadyDisputed: 0,
          disputeErrors: 0,
          listErrors: 0,
          fromBlockHeight,
          toBlockHeight: fromBlockHeight,
        };
      }

      let highestBlock = parseUnsignedBigInt(fromBlockHeight, "fromBlockHeight");
      let disputesSubmitted = 0;
      let skippedAlreadyDisputed = 0;
      let disputeErrors = 0;
      let invalidEvents = 0;
      let hasDisputeErrors = false;
      let scanned = 0;

      for (const rawEvent of events) {
        let closure;
        try {
          closure = normalizeClosureEvent(rawEvent);
        } catch {
          invalidEvents += 1;
          continue;
        }
        scanned += 1;
        const existingClosure = this.agentService.stateStore.getClosure(closure.txid);
        this.agentService.stateStore.recordClosure(closure);
        if (existingClosure?.disputed) {
          skippedAlreadyDisputed += 1;
        } else {
          let disputeResult;
          try {
            disputeResult = await this.agentService.disputeClosure({
              closureEvent: closure,
              walletPassword: this.walletPassword,
            });
          } catch (error) {
            disputeErrors += 1;
            hasDisputeErrors = true;
            this.reportError(error, `disputeClosure:${closure.txid}`);
          }
          if (disputeResult?.submitted) {
            disputesSubmitted += 1;
          }
        }

        const block = parseUnsignedBigInt(closure.blockHeight, "blockHeight");
        if (block > highestBlock) {
          highestBlock = block;
        }
      }

      const toBlockHeight = hasDisputeErrors
        ? fromBlockHeight
        : highestBlock.toString(10);
      if (!hasDisputeErrors) {
        this.agentService.stateStore.setWatcherCursor(toBlockHeight);
      }

      return {
        ok: true,
        scanned,
        invalidEvents,
        disputesSubmitted,
        skippedAlreadyDisputed,
        disputeErrors,
        listErrors: 0,
        fromBlockHeight,
        toBlockHeight,
      };
    } finally {
      this.running = false;
    }
  }
}
