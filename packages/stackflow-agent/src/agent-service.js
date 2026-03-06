import {
  buildDisputeCallInput,
  buildPipeId,
  isDisputeBeneficial,
  normalizeHex,
  normalizeClosureEvent,
  parseUnsignedBigInt,
  toUnsignedString,
} from "./utils.js";

function assertNonEmptyString(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} must be non-empty`);
  }
  return text;
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return value === true;
}

export class StackflowAgentService {
  constructor({
    stateStore,
    signer,
    chainClient = null,
    network = "devnet",
    disputeOnlyBeneficial = true,
  }) {
    if (!stateStore) {
      throw new Error("stateStore is required");
    }
    if (!signer) {
      throw new Error("signer is required");
    }

    this.stateStore = stateStore;
    this.signer = signer;
    this.chainClient = chainClient;
    this.network = String(network || "devnet").trim();
    this.disputeOnlyBeneficial = normalizeBoolean(disputeOnlyBeneficial, true);
  }

  trackPipe({
    contractId,
    pipeKey,
    localPrincipal,
    counterpartyPrincipal,
    token = null,
  }) {
    const pipeId = buildPipeId({ contractId, pipeKey });
    this.stateStore.upsertTrackedPipe({
      pipeId,
      contractId,
      pipeKey,
      localPrincipal,
      counterpartyPrincipal,
      token,
      status: "open",
      lastChainNonce: null,
    });
    return {
      pipeId,
      contractId,
      pipeKey,
      localPrincipal,
      counterpartyPrincipal,
      token: token ?? null,
    };
  }

  recordSignedState(input) {
    return this.stateStore.upsertSignatureState(input);
  }

  getTrackedPipes() {
    return this.stateStore.listTrackedPipes();
  }

  getPipeLatestState({ pipeId, forPrincipal }) {
    return this.stateStore.getLatestSignatureState(pipeId, forPrincipal);
  }

  buildOutgoingTransfer({
    pipeId,
    amount,
    actor = null,
    action = "1",
    secret = null,
    validAfter = null,
    beneficialOnly = false,
    baseMyBalance = null,
    baseTheirBalance = null,
    baseNonce = null,
  }) {
    const tracked = this.stateStore.getTrackedPipe(pipeId);
    if (!tracked) {
      throw new Error(`pipe is not tracked: ${pipeId}`);
    }

    const latest = this.stateStore.getLatestSignatureState(
      tracked.pipeId,
      tracked.localPrincipal,
    );
    const currentMy = latest
      ? parseUnsignedBigInt(latest.myBalance, "latest.myBalance")
      : parseUnsignedBigInt(
          baseMyBalance ?? "0",
          "baseMyBalance",
        );
    const currentTheir = latest
      ? parseUnsignedBigInt(latest.theirBalance, "latest.theirBalance")
      : parseUnsignedBigInt(
          baseTheirBalance ?? "0",
          "baseTheirBalance",
        );
    const currentNonce = latest
      ? parseUnsignedBigInt(latest.nonce, "latest.nonce")
      : parseUnsignedBigInt(baseNonce ?? "0", "baseNonce");

    const transferAmount = parseUnsignedBigInt(amount, "amount");
    if (transferAmount <= 0n) {
      throw new Error("amount must be > 0");
    }
    if (currentMy < transferAmount) {
      throw new Error("insufficient local balance for transfer");
    }

    const nextMy = currentMy - transferAmount;
    const nextTheir = currentTheir + transferAmount;
    const nextNonce = currentNonce + 1n;

    const normalizedActor =
      actor == null || String(actor).trim() === ""
        ? tracked.localPrincipal
        : assertNonEmptyString(actor, "actor");
    if (normalizedActor !== tracked.localPrincipal) {
      throw new Error("actor must match tracked local principal");
    }

    return {
      contractId: tracked.contractId,
      pipeKey: tracked.pipeKey,
      forPrincipal: tracked.localPrincipal,
      withPrincipal: tracked.counterpartyPrincipal,
      token: tracked.token,
      myBalance: nextMy.toString(10),
      theirBalance: nextTheir.toString(10),
      nonce: nextNonce.toString(10),
      action: toUnsignedString(action, "action"),
      actor: normalizedActor,
      secret,
      validAfter,
      beneficialOnly: beneficialOnly === true,
    };
  }

  validateIncomingTransfer({ pipeId, payload }) {
    const tracked = this.stateStore.getTrackedPipe(pipeId);
    if (!tracked) {
      return {
        valid: false,
        reason: "pipe-not-tracked",
      };
    }
    const data = payload && typeof payload === "object" ? payload : null;
    if (!data) {
      return {
        valid: false,
        reason: "payload-invalid",
      };
    }
    const contractId = String(data.contractId ?? tracked.contractId).trim();
    if (contractId !== tracked.contractId) {
      return {
        valid: false,
        reason: "contract-mismatch",
      };
    }

    if (data.pipeId != null && String(data.pipeId).trim() !== tracked.pipeId) {
      return {
        valid: false,
        reason: "pipe-id-mismatch",
      };
    }

    if (data.pipeKey != null) {
      if (!data.pipeKey || typeof data.pipeKey !== "object" || Array.isArray(data.pipeKey)) {
        return {
          valid: false,
          reason: "pipe-key-invalid",
        };
      }
      let incomingPipeId;
      try {
        incomingPipeId = buildPipeId({
          contractId,
          pipeKey: data.pipeKey,
        });
      } catch {
        return {
          valid: false,
          reason: "pipe-key-invalid",
        };
      }
      if (incomingPipeId !== tracked.pipeId) {
        return {
          valid: false,
          reason: "pipe-key-mismatch",
        };
      }
    }

    const forPrincipal = String(data.forPrincipal ?? "").trim();
    if (forPrincipal !== tracked.localPrincipal) {
      return {
        valid: false,
        reason: "for-principal-mismatch",
      };
    }
    const withPrincipal = String(data.withPrincipal ?? "").trim();
    if (withPrincipal !== tracked.counterpartyPrincipal) {
      return {
        valid: false,
        reason: "with-principal-mismatch",
      };
    }

    const trackedToken =
      tracked.token == null ? null : String(tracked.token).trim();
    const payloadToken =
      data.token == null ? trackedToken : String(data.token).trim();
    if (payloadToken !== trackedToken) {
      return {
        valid: false,
        reason: "token-mismatch",
      };
    }
    const theirSignature = (() => {
      try {
        return normalizeHex(data.theirSignature, "theirSignature");
      } catch {
        return null;
      }
    })();
    if (!theirSignature) {
      return {
        valid: false,
        reason: "missing-or-invalid-their-signature",
      };
    }
    let nonce;
    let action;
    let myBalance;
    let theirBalance;
    try {
      nonce = toUnsignedString(data.nonce, "nonce");
      action = toUnsignedString(data.action ?? "1", "action");
      myBalance = toUnsignedString(data.myBalance, "myBalance");
      theirBalance = toUnsignedString(data.theirBalance, "theirBalance");
    } catch (error) {
      return {
        valid: false,
        reason: error instanceof Error ? error.message : "invalid-payload",
      };
    }
    const actor = String(data.actor ?? "").trim();
    if (!actor) {
      return {
        valid: false,
        reason: "actor-missing",
      };
    }
    if (actor !== tracked.counterpartyPrincipal) {
      return {
        valid: false,
        reason: "actor-mismatch",
      };
    }
    const latest = this.stateStore.getLatestSignatureState(
      tracked.pipeId,
      tracked.localPrincipal,
    );
    if (latest) {
      const existingNonce = parseUnsignedBigInt(latest.nonce, "existing nonce");
      const incomingNonce = parseUnsignedBigInt(nonce, "incoming nonce");
      if (incomingNonce <= existingNonce) {
        return {
          valid: false,
          reason: "nonce-too-low",
          existingNonce: latest.nonce,
        };
      }
      if (incomingNonce !== existingNonce + 1n) {
        return {
          valid: false,
          reason: "nonce-not-sequential",
          existingNonce: latest.nonce,
        };
      }

      const existingMyBalance = parseUnsignedBigInt(
        latest.myBalance,
        "existing myBalance",
      );
      const existingTheirBalance = parseUnsignedBigInt(
        latest.theirBalance,
        "existing theirBalance",
      );
      const incomingMyBalance = parseUnsignedBigInt(myBalance, "incoming myBalance");
      const incomingTheirBalance = parseUnsignedBigInt(
        theirBalance,
        "incoming theirBalance",
      );

      if (
        incomingMyBalance + incomingTheirBalance !==
        existingMyBalance + existingTheirBalance
      ) {
        return {
          valid: false,
          reason: "balance-sum-mismatch",
        };
      }

      if (
        incomingMyBalance < existingMyBalance ||
        incomingTheirBalance > existingTheirBalance
      ) {
        return {
          valid: false,
          reason: "balance-direction-invalid",
        };
      }
    }

    let secret = null;
    try {
      secret = data.secret == null ? null : normalizeHex(data.secret, "secret");
    } catch (error) {
      return {
        valid: false,
        reason: error instanceof Error ? error.message : "invalid-secret",
      };
    }

    return {
      valid: true,
      state: {
        contractId,
        pipeId: tracked.pipeId,
        pipeKey: tracked.pipeKey,
        forPrincipal,
        withPrincipal,
        token: trackedToken,
        myBalance,
        theirBalance,
        nonce,
        action,
        actor,
        mySignature: null,
        theirSignature,
        secret,
        validAfter:
          data.validAfter == null
            ? null
            : toUnsignedString(data.validAfter, "validAfter"),
        beneficialOnly: data.beneficialOnly === true,
      },
    };
  }

  async signTransferMessage({
    contractId,
    message,
    walletPassword = null,
  }) {
    if (typeof this.signer.sip018Sign !== "function") {
      throw new Error("signer.sip018Sign is required");
    }
    return this.signer.sip018Sign({
      contract: contractId,
      message,
      walletPassword,
    });
  }

  async acceptIncomingTransfer({
    pipeId,
    payload,
    walletPassword = null,
  }) {
    const validation = this.validateIncomingTransfer({
      pipeId,
      payload,
    });
    if (!validation.valid) {
      return {
        accepted: false,
        ...validation,
      };
    }

    const state = validation.state;

    // Build the flat Clarity-typed message matching the on-chain SIP-018 domain.
    // balance-1 always corresponds to principal-1 in the pipe key (canonical ordering),
    // regardless of which side the local agent is on.
    const pipeKey = state.pipeKey;
    const localIsPrincipal1 = pipeKey["principal-1"] === state.forPrincipal;
    const balance1 = localIsPrincipal1 ? state.myBalance : state.theirBalance;
    const balance2 = localIsPrincipal1 ? state.theirBalance : state.myBalance;

    const message = {
      "principal-1": { type: "principal", value: pipeKey["principal-1"] },
      "principal-2": { type: "principal", value: pipeKey["principal-2"] },
      token:
        pipeKey.token == null
          ? { type: "none" }
          : { type: "some", value: { type: "principal", value: String(pipeKey.token) } },
      "balance-1": { type: "uint", value: Number(balance1) },
      "balance-2": { type: "uint", value: Number(balance2) },
      nonce: { type: "uint", value: Number(state.nonce) },
      action: { type: "uint", value: Number(state.action) },
      actor: { type: "principal", value: state.actor },
      "hashed-secret":
        state.secret == null
          ? { type: "none" }
          : { type: "some", value: { type: "buff", value: state.secret } },
      "valid-after":
        state.validAfter == null
          ? { type: "none" }
          : { type: "some", value: { type: "uint", value: Number(state.validAfter) } },
    };

    const mySignature = await this.signTransferMessage({
      contractId: state.contractId,
      message,
      walletPassword,
    });

    const upsert = this.stateStore.upsertSignatureState({
      ...state,
      mySignature,
    });

    return {
      accepted: true,
      mySignature,
      upsert,
      state,
    };
  }

  buildOpenPipeCall({
    contractId,
    token = null,
    amount,
    counterpartyPrincipal,
    nonce = "0",
  }) {
    return {
      contractId: assertNonEmptyString(contractId, "contractId"),
      functionName: "fund-pipe",
      functionArgs: [
        token,
        toUnsignedString(amount, "amount"),
        assertNonEmptyString(counterpartyPrincipal, "counterpartyPrincipal"),
        toUnsignedString(nonce, "nonce"),
      ],
    };
  }

  async openPipe(args) {
    const call = this.buildOpenPipeCall(args);
    return this.signer.callContract({
      contractId: call.contractId,
      functionName: call.functionName,
      functionArgs: call.functionArgs,
      network: this.network,
    });
  }

  evaluateClosureForDispute(event) {
    const closure = normalizeClosureEvent(event);
    const trackedPipe = this.stateStore.getTrackedPipe(closure.pipeId);
    if (!trackedPipe) {
      return {
        closure,
        tracked: false,
        shouldDispute: false,
        reason: "pipe-not-tracked",
      };
    }

    const latestState = this.stateStore.getLatestSignatureState(
      closure.pipeId,
      trackedPipe.localPrincipal,
    );
    if (!latestState) {
      return {
        closure,
        tracked: true,
        shouldDispute: false,
        reason: "no-local-signature-state",
      };
    }

    const shouldDispute = isDisputeBeneficial({
      closureEvent: closure,
      signatureState: latestState,
      onlyBeneficial: this.disputeOnlyBeneficial,
    });

    return {
      closure,
      tracked: true,
      shouldDispute,
      reason: shouldDispute ? "eligible" : "not-beneficial-or-stale",
      latestState,
    };
  }

  async disputeClosure({
    closureEvent,
    walletPassword = null,
  }) {
    const decision = this.evaluateClosureForDispute(closureEvent);
    if (!decision.shouldDispute) {
      return {
        submitted: false,
        reason: decision.reason,
        decision,
      };
    }

    const result = await this.signer.submitDispute({
      closureEvent: decision.closure,
      signatureState: decision.latestState,
      network: this.network,
      walletPassword,
    });

    const disputeTxid =
      typeof result.txid === "string"
        ? result.txid
        : typeof result.data?.txid === "string"
          ? result.data.txid
          : null;
    if (disputeTxid) {
      this.stateStore.markClosureDisputed({
        txid: decision.closure.txid,
        disputeTxid,
      });
    }

    return {
      submitted: true,
      disputeTxid,
      callInput: buildDisputeCallInput({
        closureEvent: decision.closure,
        signatureState: decision.latestState,
      }),
      decision,
      raw: result,
    };
  }
}
