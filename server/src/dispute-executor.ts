import { createNetwork } from '@stacks/network';
import {
  PostConditionMode,
  broadcastTransaction,
  bufferCV,
  getAddressFromPrivateKey,
  makeContractCall,
  noneCV,
  principalCV,
  someCV,
  uintCV,
} from '@stacks/transactions';

import { hexToBytes, splitContractId } from './principal-utils.js';
import type {
  ClosureRecord,
  DisputeExecutor,
  SignatureStateRecord,
  StackflowPrintEvent,
  SubmitDisputeResult,
  StackflowNodeConfig,
} from './types.js';

function normalizePrivateKey(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
}

function parseContractPrincipal(contractId: string): { address: string; name: string } {
  return splitContractId(contractId);
}

export class StacksDisputeExecutor implements DisputeExecutor {
  readonly enabled: boolean;

  readonly signerAddress: string | null;

  private readonly network: ReturnType<typeof createNetwork>;

  private readonly disputeSignerKey: string | null;

  constructor(config: Pick<StackflowNodeConfig, 'stacksNetwork' | 'stacksApiUrl' | 'disputeSignerKey'>) {
    this.network = createNetwork({
      network: config.stacksNetwork,
      client: config.stacksApiUrl ? { baseUrl: config.stacksApiUrl } : undefined,
    });

    this.disputeSignerKey = config.disputeSignerKey ? normalizePrivateKey(config.disputeSignerKey) : null;

    this.enabled = Boolean(this.disputeSignerKey);
    this.signerAddress = this.disputeSignerKey
      ? getAddressFromPrivateKey(this.disputeSignerKey, this.network)
      : null;
  }

  async submitDispute({
    signatureState,
  }: {
    signatureState: SignatureStateRecord;
    closure: ClosureRecord;
    triggerEvent: StackflowPrintEvent;
  }): Promise<SubmitDisputeResult> {
    if (!this.disputeSignerKey) {
      throw new Error('stackflow-node dispute signer key not configured');
    }

    const contract = parseContractPrincipal(signatureState.contractId);

    const tokenArg = signatureState.token
      ? someCV(principalCV(signatureState.token))
      : noneCV();

    const secretArg = signatureState.secret
      ? someCV(bufferCV(hexToBytes(signatureState.secret)))
      : noneCV();

    const validAfterArg = signatureState.validAfter
      ? someCV(uintCV(BigInt(signatureState.validAfter)))
      : noneCV();

    const tx = await makeContractCall({
      network: this.network,
      senderKey: this.disputeSignerKey,
      contractAddress: contract.address,
      contractName: contract.name,
      functionName: 'dispute-closure-for',
      functionArgs: [
        principalCV(signatureState.forPrincipal),
        tokenArg,
        principalCV(signatureState.withPrincipal),
        uintCV(BigInt(signatureState.myBalance)),
        uintCV(BigInt(signatureState.theirBalance)),
        bufferCV(hexToBytes(signatureState.mySignature)),
        bufferCV(hexToBytes(signatureState.theirSignature)),
        uintCV(BigInt(signatureState.nonce)),
        uintCV(BigInt(signatureState.action)),
        principalCV(signatureState.actor),
        secretArg,
        validAfterArg,
      ],
      postConditionMode: PostConditionMode.Allow,
      validateWithAbi: false,
    });

    const result = await broadcastTransaction({
      transaction: tx,
      network: this.network,
    });

    if ('reason' in result) {
      throw new Error(
        `dispute broadcast failed: ${result.reason}${result.error ? ` (${result.error})` : ''}`,
      );
    }

    return { txid: result.txid };
  }
}

export class NoopDisputeExecutor implements DisputeExecutor {
  readonly enabled = false;

  readonly signerAddress = null;

  async submitDispute(): Promise<SubmitDisputeResult> {
    throw new Error('dispute executor disabled');
  }
}

export class MockDisputeExecutor implements DisputeExecutor {
  readonly enabled = true;

  readonly signerAddress = 'ST3AM1A8YQ4X5MMR7Z5T3VYV9N0ZVEX7QPHQ4RM9P';

  private nonce = 0;

  async submitDispute(): Promise<SubmitDisputeResult> {
    this.nonce += 1;
    return { txid: `0xmock${this.nonce.toString(16).padStart(8, '0')}` };
  }
}
