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

export interface WatchtowerPersistedState {
  version: number;
  updatedAt: string | null;
  activeClosures: Record<string, ClosureRecord>;
  observedPipes: Record<string, ObservedPipeRecord>;
  signatureStates: Record<string, SignatureStateRecord>;
  disputeAttempts: Record<string, DisputeAttemptRecord>;
  recentEvents: RecordedWatchtowerEvent[];
}

export interface RecordedWatchtowerEvent extends StackflowPrintEvent {
  source: string | null;
  observedAt: string;
}

export interface WatchtowerStatus {
  version: number;
  updatedAt: string | null;
  activeClosures: ClosureRecord[];
  observedPipes: ObservedPipeRecord[];
  signatureStates: SignatureStateRecord[];
  disputeAttempts: DisputeAttemptRecord[];
  recentEvents: RecordedWatchtowerEvent[];
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

export type ProducerSignerMode =
  | 'local-key'
  | 'kms';

export interface WatchtowerConfig {
  host: string;
  port: number;
  dbFile: string;
  maxRecentEvents: number;
  logRawEvents: boolean;
  watchedContracts: string[];
  watchedPrincipals: string[];
  stacksNetwork: 'mainnet' | 'testnet' | 'devnet' | 'mocknet';
  stacksApiUrl: string | null;
  signerKey: string | null;
  producerKey: string | null;
  producerPrincipal: string | null;
  producerSignerMode: ProducerSignerMode;
  stackflowMessageVersion: string;
  signatureVerifierMode: SignatureVerifierMode;
  disputeExecutorMode: DisputeExecutorMode;
  disputeOnlyBeneficial: boolean;
}

export interface SubmitDisputeResult {
  txid: string;
}

export interface DisputeExecutor {
  readonly enabled: boolean;
  readonly signerAddress: string | null;
  submitDispute(args: {
    signatureState: SignatureStateRecord;
    closure: ClosureRecord;
    triggerEvent: StackflowPrintEvent;
  }): Promise<SubmitDisputeResult>;
}
