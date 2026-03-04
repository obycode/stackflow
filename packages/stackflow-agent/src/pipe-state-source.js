function assertNonEmptyString(value, fieldName) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`${fieldName} must be non-empty`);
  }
  return text;
}

export class AibtcPipeStateSource {
  constructor({
    walletAdapter,
    contractId,
    network = "devnet",
  }) {
    if (!walletAdapter || typeof walletAdapter.getPipe !== "function") {
      throw new Error("walletAdapter.getPipe is required");
    }
    this.walletAdapter = walletAdapter;
    this.contractId = assertNonEmptyString(contractId, "contractId");
    this.network = String(network || "devnet").trim();
  }

  async getPipeState({
    token = null,
    forPrincipal,
    withPrincipal,
  }) {
    return this.walletAdapter.getPipe({
      contractId: this.contractId,
      token,
      forPrincipal,
      withPrincipal,
      network: this.network,
    });
  }
}
