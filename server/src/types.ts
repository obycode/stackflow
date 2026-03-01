export interface PipeKey {
  'principal-1': string;
  'principal-2': string;
  token: string | null;
}

export interface PipePendingSnapshot {
  amount: string | null;
  'burn-height': string | null;
}

export interface PipeSnapshot {
  'balance-1': string | null;
  'balance-2': string | null;
  'pending-1': PipePendingSnapshot | null;
  'pending-2': PipePendingSnapshot | null;
  'expires-at': string | null;
  nonce: string | null;
  closer: string | null;
}

export interface StackflowPrintEvent {
  contractId: string;
  topic: 'print';
  txid: string | null;
  blockHeight: string | null;
  blockHash: string | null;
  eventIndex: string | null;
  eventName: string | null;
  sender: string | null;
  pipeKey: PipeKey | null;
  pipe: PipeSnapshot | null;
  repr: string | null;
}

export interface ClosureRecord {
  pipeId: string;
  contractId: string;
  pipeKey: PipeKey;
  closer: string | null;
  expiresAt: string | null;
  nonce: string | null;
  event: string;
  txid: string | null;
  blockHeight: string | null;
  updatedAt: string;
}

export interface ObservedPipeRecord {
  stateId: string;
  pipeId: string;
  contractId: string;
  pipeKey: PipeKey;
  balance1: string | null;
  balance2: string | null;
  pending1Amount: string | null;
  pending1BurnHeight: string | null;
  pending2Amount: string | null;
  pending2BurnHeight: string | null;
  expiresAt: string | null;
  nonce: string | null;
  closer: string | null;
  event: string;
  txid: string | null;
  blockHeight: string | null;
  updatedAt: string;
}

export interface SignatureStateRecord {
  stateId: string;
  pipeId: string;
  contractId: string;
  forPrincipal: string;
  withPrincipal: string;
  token: string | null;
  amount: string;
  myBalance: string;
  theirBalance: string;
  mySignature: string;
  theirSignature: string;
  nonce: string;
  action: string;
  actor: string;
  secret: string | null;
  validAfter: string | null;
  beneficialOnly: boolean;
  updatedAt: string;
}

export interface SignatureStateInput {
  contractId: string;
  forPrincipal: string;
  withPrincipal: string;
  token: string | null;
  amount: string;
  myBalance: string;
  theirBalance: string;
  mySignature: string;
  theirSignature: string;
  nonce: string;
  action: string;
  actor: string;
  secret: string | null;
  validAfter: string | null;
  beneficialOnly: boolean;
}

export interface SignatureStateUpsertResult {
  stored: boolean;
  replaced: boolean;
  reason: string | null;
  state: SignatureStateRecord;
}

export interface SignatureVerificationResult {
  valid: boolean;
  reason: string | null;
}

export interface SignatureVerifier {
  verifySignatureState(
    input: SignatureStateInput,
  ): Promise<SignatureVerificationResult>;
}

export interface DisputeAttemptRecord {
  attemptId: string;
  contractId: string;
  pipeId: string;
  forPrincipal: string;
  triggerTxid: string | null;
  success: boolean;
  disputeTxid: string | null;
  error: string | null;
  createdAt: string;
}

export interface StackflowNodePersistedState {
  version: number;
  updatedAt: string | null;
  activeClosures: Record<string, ClosureRecord>;
  observedPipes: Record<string, ObservedPipeRecord>;
  signatureStates: Record<string, SignatureStateRecord>;
  disputeAttempts: Record<string, DisputeAttemptRecord>;
  recentEvents: RecordedStackflowNodeEvent[];
}

export interface IdempotentResponseRecord {
  endpoint: string;
  idempotencyKey: string;
  requestHash: string;
  statusCode: number;
  responseJson: Record<string, unknown>;
  createdAt: string;
}

export interface ForwardingPaymentRecord {
  paymentId: string;
  contractId: string | null;
  pipeId: string | null;
  pipeNonce: string | null;
  status: 'completed' | 'failed';
  incomingAmount: string;
  outgoingAmount: string;
  feeAmount: string;
  hashedSecret: string | null;
  revealedSecret: string | null;
  revealedAt: string | null;
  upstreamBaseUrl: string | null;
  upstreamRevealEndpoint: string | null;
  upstreamPaymentId: string | null;
  revealPropagationStatus: 'not-applicable' | 'pending' | 'propagated' | 'failed';
  revealPropagationAttempts: number;
  revealLastError: string | null;
  revealNextRetryAt: string | null;
  revealPropagatedAt: string | null;
  nextHopBaseUrl: string;
  nextHopEndpoint: string;
  resultJson: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordedStackflowNodeEvent extends StackflowPrintEvent {
  source: string | null;
  observedAt: string;
}

export interface StackflowNodeStatus {
  version: number;
  updatedAt: string | null;
  activeClosures: ClosureRecord[];
  observedPipes: ObservedPipeRecord[];
  signatureStates: SignatureStateRecord[];
  disputeAttempts: DisputeAttemptRecord[];
  recentEvents: RecordedStackflowNodeEvent[];
}

export interface IngestResult {
  observedEvents: number;
  activeClosures: number;
}

export type SignatureVerifierMode =
  | 'readonly'
  | 'accept-all'
  | 'reject-all';

export type DisputeExecutorMode =
  | 'auto'
  | 'noop'
  | 'mock';

export type CounterpartySignerMode =
  | 'local-key'
  | 'kms';

export interface StackflowNodeConfig {
  host: string;
  port: number;
  dbFile: string;
  maxRecentEvents: number;
  logRawEvents: boolean;
  watchedContracts: string[];
  watchedPrincipals: string[];
  stacksNetwork: 'mainnet' | 'testnet' | 'devnet' | 'mocknet';
  stacksApiUrl: string | null;
  disputeSignerKey: string | null;
  counterpartyKey: string | null;
  counterpartyPrincipal: string | null;
  counterpartySignerMode: CounterpartySignerMode;
  counterpartyKmsKeyId: string | null;
  counterpartyKmsRegion: string | null;
  counterpartyKmsEndpoint: string | null;
  stackflowMessageVersion: string;
  signatureVerifierMode: SignatureVerifierMode;
  disputeExecutorMode: DisputeExecutorMode;
  disputeOnlyBeneficial: boolean;
  peerWriteRateLimitPerMinute: number;
  trustProxy: boolean;
  observerLocalhostOnly: boolean;
  observerAllowedIps: string[];
  adminReadToken: string | null;
  adminReadLocalhostOnly: boolean;
  redactSensitiveReadData: boolean;
  forwardingEnabled: boolean;
  forwardingMinFee: string;
  forwardingTimeoutMs: number;
  forwardingAllowPrivateDestinations: boolean;
  forwardingAllowedBaseUrls: string[];
  forwardingRevealRetryIntervalMs: number;
  forwardingRevealRetryMaxAttempts: number;
}

export interface SubmitDisputeResult {
  txid: string;
}

export interface DisputeExecutor {
  readonly enabled: boolean;
  readonly signerAddress: string | null;
  submitDispute(args: {
    signatureState: SignatureStateRecord;
    resolvedSecret: string | null;
    closure: ClosureRecord;
    triggerEvent: StackflowPrintEvent;
  }): Promise<SubmitDisputeResult>;
}
