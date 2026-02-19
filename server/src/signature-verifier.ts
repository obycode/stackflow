import { createNetwork } from '@stacks/network';
import {
  ClarityType,
  bufferCV,
  fetchCallReadOnlyFunction,
  noneCV,
  principalCV,
  someCV,
  tupleCV,
  uintCV,
} from '@stacks/transactions';

import { canonicalPipeKey, hexToBytes, splitContractId } from './principal-utils.js';
import type {
  SignatureStateInput,
  SignatureVerificationResult,
  SignatureVerifier,
  StackflowNodeConfig,
} from './types.js';

const STACKFLOW_CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  '100': 'deposit failed',
  '101': 'no such pipe',
  '102': 'invalid principal',
  '103': 'invalid sender signature',
  '104': 'invalid other signature',
  '105': 'consensus serialization failed',
  '106': 'unauthorized',
  '107': 'max allowed exceeded',
  '108': 'invalid total balance',
  '109': 'withdrawal failed',
  '110': 'pipe expired',
  '111': 'nonce too low',
  '112': 'close in progress',
  '113': 'no close in progress',
  '114': 'self dispute is not allowed',
  '115': 'already funded',
  '116': 'invalid withdrawal',
  '117': 'unapproved token',
  '118': 'not expired',
  '119': 'contract not initialized',
  '120': 'contract already initialized',
  '121': 'transfer not valid yet',
  '122': 'already pending',
  '123': 'pending deposit exists',
  '124': 'invalid balances',
  '125': 'invalid signature',
  '126': 'allowance violation',
  '127': 'self-pipe is not allowed',
};

export function describeStackflowContractError(code: string | number | bigint): string {
  const codeText = String(code);
  const message = STACKFLOW_CONTRACT_ERROR_MESSAGES[codeText];
  if (message) {
    return `${message} (contract err u${codeText})`;
  }

  return `contract error u${codeText}`;
}

function senderAddressForPrincipal(principal: string): string {
  if (principal.includes('.')) {
    return splitContractId(principal).address;
  }
  return principal;
}

export class ReadOnlySignatureVerifier implements SignatureVerifier {
  private readonly network: ReturnType<typeof createNetwork>;

  constructor(config: Pick<StackflowNodeConfig, 'stacksNetwork' | 'stacksApiUrl'>) {
    this.network = createNetwork({
      network: config.stacksNetwork,
      client: config.stacksApiUrl ? { baseUrl: config.stacksApiUrl } : undefined,
    });
  }

  async verifySignatureState(
    input: SignatureStateInput,
  ): Promise<SignatureVerificationResult> {
    const contract = splitContractId(input.contractId);
    const pipeKey = canonicalPipeKey(
      input.token,
      input.forPrincipal,
      input.withPrincipal,
    );

    const balance1 =
      pipeKey['principal-1'] === input.forPrincipal
        ? input.myBalance
        : input.theirBalance;
    const balance2 =
      pipeKey['principal-1'] === input.forPrincipal
        ? input.theirBalance
        : input.myBalance;

    const tokenArg = input.token ? someCV(principalCV(input.token)) : noneCV();
    const secretArg = input.secret
      ? someCV(bufferCV(hexToBytes(input.secret)))
      : noneCV();
    const validAfterArg = input.validAfter
      ? someCV(uintCV(BigInt(input.validAfter)))
      : noneCV();

    const functionArgs = (
      signature: string,
      signer: string,
    ) => [
      bufferCV(hexToBytes(signature)),
      principalCV(signer),
      tupleCV({
        token: tokenArg,
        'principal-1': principalCV(pipeKey['principal-1']),
        'principal-2': principalCV(pipeKey['principal-2']),
      }),
      uintCV(BigInt(balance1)),
      uintCV(BigInt(balance2)),
      uintCV(BigInt(input.nonce)),
      uintCV(BigInt(input.action)),
      principalCV(input.actor),
      secretArg,
      validAfterArg,
      uintCV(BigInt(input.amount)),
    ];

    const verifyOne = async (
      signature: string,
      signer: string,
    ): Promise<SignatureVerificationResult> => {
      const response = await fetchCallReadOnlyFunction({
        network: this.network,
        senderAddress: senderAddressForPrincipal(input.forPrincipal),
        contractAddress: contract.address,
        contractName: contract.name,
        functionName: 'verify-signature-request',
        functionArgs: functionArgs(signature, signer),
      });

      if (response.type === ClarityType.ResponseErr) {
        if (response.value.type === ClarityType.UInt) {
          return {
            valid: false,
            reason: describeStackflowContractError(response.value.value),
          };
        }

        return { valid: false, reason: 'contract error' };
      }

      if (response.type !== ClarityType.ResponseOk) {
        return { valid: false, reason: 'unexpected-readonly-response' };
      }

      if (
        response.value.type === ClarityType.OptionalNone ||
        response.value.type === ClarityType.OptionalSome
      ) {
        return { valid: true, reason: null };
      }

      return {
        valid: false,
        reason: 'verify-signature-request-returned-unexpected-value',
      };
    };

    const myVerification = await verifyOne(input.mySignature, input.forPrincipal);
    if (!myVerification.valid) {
      return myVerification;
    }

    return verifyOne(input.theirSignature, input.withPrincipal);
  }
}

export class AcceptAllSignatureVerifier implements SignatureVerifier {
  async verifySignatureState(
    _input: SignatureStateInput,
  ): Promise<SignatureVerificationResult> {
    return { valid: true, reason: null };
  }
}

export class RejectAllSignatureVerifier implements SignatureVerifier {
  private readonly reason: string;

  constructor(reason = 'invalid-signature') {
    this.reason = reason;
  }

  async verifySignatureState(
    _input: SignatureStateInput,
  ): Promise<SignatureVerificationResult> {
    return { valid: false, reason: this.reason };
  }
}
