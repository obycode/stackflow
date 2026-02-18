Stackflow is a payment channel network built on Stacks that enables off-chain,
non-custodial, high-speed payments between users and is designed to be simple,
secure, and efficient. It supports payments in STX or SIP-010 fungible tokens.

> [!NOTE]
> The Stackflow trait is published by `stackflow.btc` on mainnet at
> `SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-token-0-5-0` and on testnet at
> `ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-token-0-5-0`.

> [!NOTE]
> The official Stackflow contract for STX is published by `stackflow.btc` on
> mainnet at `SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-0-6-0` and
> on testnet at `ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-6-0`.
> Contracts for other tokens should copy this contract exactly to ensure that
> all Stackflow frontends will support it.

> [!NOTE]
> The official Stackflow contract for sBTC is published by `stackflow.btc` on
> mainnet at `SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-sbtc-0-6-0`
> and on testnet at
> `ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-sbtc-0-6-0`.

A Stacks address can open a Pipe with any other Stacks address or open a Tap to
the Reservoir by calling the Stackflow contract. In a Pipe, tokens are sent into
escrow and locked in the contract, and can only be withdrawn by the Pipe
participants. Alternatively, by opening a Tap, a user deposits tokens directly
into the contract where their balance is tracked on a shared ledger (the
Reservoir). Users can then send payments off-chain using either direct Pipes or
via the Reservoir.

In both cases, off-chain signed messages are exchanged to update balances. These
messages include a nonce to track their ordering.
[SIP-018 structured data](https://github.com/stacksgov/sips/blob/main/sips/sip-018/sip-018-signed-structured-data.md)
indicating the agreed upon balances of each participant. These signed messages
can be exchanged off-chain and only need to be submitted on-chain when closing
the Pipe, depositing additional funds to, or withdrawing funds from the Pipe.
The messages include a nonce to track their ordering. The SIP-018 domain is
bound to the specific StackFlow contract principal, so signatures are not
reusable across different StackFlow contract instances.

A Pipe can be closed cooperatively at any time, with both parties agreeing on
the final balances and signing off on the closure. If either party becomes
uncooperative or unresponsive, the Pipe can also be forcefully closed by the
other party. One party can initiate a waiting period to cancel the Pipe and
refund the latest balances recorded in the contract, or they can submit
signatures verifying an agreed upon balance. In either case, the counterparty
has 144 Bitcoin blocks (~1 day) to rebut the submitted balances by providing a
newer set of signed messages. If the closure is successfully disputed with valid
signatures, those balances are immediately paid out and the Pipe is closed. If
the deadline passes with no dispute, a final contract call triggers the payout
to both parties.

Pipes can be chained together to enable payments between users who do not have a
direct Pipe open between them. This is done by routing the payment through
intermediaries who have Pipes open with both the sender and receiver. Off-chain,
tools can find the most efficient path to route the payment. Intermediary nodes
can charge a fee for routing payments. In the case of chained Pipes, the signed
messages passed around include a requirement for a secret to unlock the funds.
This ensures that if any hop in the chain fails to send the tokens as promised,
the whole transaction can be reverted, allowing the sender and receiver to be
sure that the payment goes through completely or they get their tokens back,
even with untrusted intermediaries.

Example:

1. Alice opens a Pipe with Bob.
2. Bob opens a Pipe with Charlie.
3. Alice wants to send 10 STX to Charlie.
4. Alice sends a signed message to Bob indicating that she wants to send 10 STX
   to Charlie and is willing to pay Bob 0.1 STX for routing the payment. Alice's
   signature transferring 10.1 STX to Bob is invalid unless Bob can provide the
   secret, for which a hash was included in the structured data signed by Alice.
5. Bob sends a signed message to Charlie indicating that he wants to send him 10
   STX. Charlie is able to decrypt the secret and sends it back to Bob and the
   chain is complete.

In the above scenario, Bob cannot obtain the secret unless he sends the payment
to Charlie, so he is unable to keep the payment from Alice without sending the
payment to Charlie. Details of how this works are discussed below.

# Details

## Transfers

### Simple Transfers

To send tokens between two parties with an active Pipe open in the contract,
they simply send signatures back and forth off-chain. The signatures are signing
over structured data with the details of the Pipe:

```clarity
{
   ;; The token for which the Pipe is open
   token: (optional principal),
   ;; The first principal, ordered by the principals' consensus serialization
   principal-1: principal,
   ;; The second principal, ordered by the principals' consensus serialization
   principal-2: principal,
   ;; The balance of principal-1
   balance-1: uint,
   ;; The balance of principal-2
   balance-2: uint,
   ;; A monotonically increasing identifier for this action
   nonce: uint,
   ;; The type of action (u0 = close, u1 = transfer, u2 = deposit, u3 = withdraw)
   action: uint,
   ;; The principal initiating the action, `none` for close
   actor: (optional principal),
   ;; An optional sha256 hash of a secret, used for multi-hop transfers or
   ;; other advanced functionality
   hashed-secret: (optional (buff 32))
   ;; An optional Bitcoin block height at which this transfer becomes valid. If
   ;; set, this transfer cannot be used in `force-close` or `dispute-closure`
   ;; to validate balances until the specified block height has passed.
   valid-after: (optional uint)
}
```

In this direct transfer scenario, the `hashed-secret` is not needed, and can be
set to `none`.

When **A** wants to send to **B**, **A** builds this data structure with the
adjusted balances and the appropriate nonce, signs over it, and then sends these
in a message to **B**. **B** validates the signature, and verifies that the new
balances match an incoming transfer. If everything is correct, then **B**
responds to **A** with a signature of its own. Both parties (or a representative
thereof) should record these new signatures and balances. Future transactions
should build from these balances, and the signatures may be needed to dispute if
something goes wrong later.

### Multi-Hop Transfers

When principal **A** wants to send tokens to principal **D** using StackFlow,
first, a path from **A** to **D** is identified using existing open Pipes with
sufficient balances, for example using Dijkstra's algorithm. If a path is not
possible, then a new Pipe must be opened. Once a path is defined, **A** builds
the transfer message as described above, with the addition of a secret.

The next part of the transfer message describes what the receiver must do in
order to get the Pipe balance confirmed. For the final hop in the chain, the
target receiver of the payment will have no next hop, since at that point, the
payment is complete. For all other hops in the chain, the receiver of the
message uses the next hop to determine how to build its transfer message,
defining which principal to send to, `receiver`, how much to send, `amount`, how
much should be leftover to keep for itself as a fee, `fee`, an encrypted secret,
`secret`.

```ts
type Hop = {
  receiver: string;
  amount: bigint;
  fee: bigint;
  secret: Uint8Array;
  nextHop: Number;
};
```

The initial sender constructs an array of 8 of these `Hop` objects, encrypting
each with the public key of the intended target. If less than 8 hops are needed,
then random data is filled into the remaining slots. The sender then sends this
array, along with its signature to the first hop in the chain, along with the
index for that hop. That first hop decrypts the value at the specified hop and
uses the information within to send a signature and the array to the next hop,
along with the index for that next hop.

For the final hop in the chain, **D** in our example, the `receiver` is set to
**D** itself and the amount is set to `0`. This is the signal to **D** that it
is the final destination for this payment, so it can reply back to the previous
hop with the decrypted secret. Each hop validates, then passes this decrypted
secret back to its predecessor, eventually reaching the source and validating
the completed payment.

## Closing a Pipe

There are two ways to close a Pipe, cooperatively or forcefully. In the normal
scenario, both parties agree to close the Pipe and authorize the closure by
signing a message agreeing upon the final balances. One party calls
`close-pipe`, passing in these balances and signatures, and then the contract
pays out both parties and the Pipe is closed.

In the unfortunate scenario where one party becomes uncooperative or
unresponsive, the other party needs a way to retrieve their funds from the Pipe
unilaterally. This user has two options:

1. `force-cancel` allows the user to close the Pipe and refund the initial
   balances to both parties. This option requires no signatures, but it does
   require a waiting period, allowing the other party to dispute the closure by
   submitting signatures validating a transfer on this Pipe.
2. `force-close` allows the user to close the Pipe and return the balances
   recorded in the latest transfer on this Pipe. Arguments to this function
   include signatures from the latest transfer, along with the agreed upon
   balances at that transfer. This function also requires a waiting period,
   allowing the other party to dispute the closure by submitting a later pair of
   signatures, indicating a more recent balance agreement (one with a higher
   nonce).

During the waiting period for both of these closures, the other party may call
`dispute-closure`, passing in balances and signatures from the latest transfer.
If the signatures are confirmed, and the nonce is higher in the case of a
`force-close`, then the Pipe is immediately closed, transferring with the
balances specified to both parties.

If the closure is not disputed by the time the waiting period is over, the user
may call `finalize` to complete the closure and transfer the appropriate
balances to both parties.

# Built-in Watchtower (Event Observer)

This repo now includes a minimal watchtower service at `server/src/index.ts`. It
is designed to run as a stacks-node event observer, ingest `print` events from
Stackflow contracts, store latest signed states, and auto-submit
`dispute-closure-for` when a `force-close` or `force-cancel` is observed.

Run it with:

```bash
npm run watchtower
```

Optional environment variables:

```bash
WATCHTOWER_HOST=0.0.0.0
WATCHTOWER_PORT=8787
WATCHTOWER_DB_FILE=server/data/watchtower-state.db
WATCHTOWER_MAX_RECENT_EVENTS=500
WATCHTOWER_LOG_RAW_EVENTS=false
STACKFLOW_CONTRACTS=ST....stackflow-0-6-0,ST....stackflow-sbtc-0-6-0
WATCHTOWER_PRINCIPALS=ST...,ST...
STACKS_NETWORK=devnet
STACKS_API_URL=http://localhost:20443
WATCHTOWER_SIGNER_KEY=<private-key-used-to-submit-disputes>
WATCHTOWER_PRODUCER_KEY=<private-key-used-to-sign-off-chain-states>
WATCHTOWER_PRODUCER_PRINCIPAL=<optional principal to sign for, e.g. ST... or ST....contract>
WATCHTOWER_PRODUCER_SIGNER_MODE=local-key
WATCHTOWER_STACKFLOW_MESSAGE_VERSION=0.6.0
WATCHTOWER_SIGNATURE_VERIFIER_MODE=readonly
WATCHTOWER_DISPUTE_EXECUTOR_MODE=auto
WATCHTOWER_DISPUTE_ONLY_BENEFICIAL=false
```

If `STACKFLOW_CONTRACTS` is omitted, the watchtower automatically monitors any
contract identifier matching `*.stackflow*`.
`WATCHTOWER_STATE_FILE` is still accepted as a backward-compatible alias for
`WATCHTOWER_DB_FILE`.
The current implementation uses Node's `node:sqlite` module for persistence.
`WATCHTOWER_SIGNATURE_VERIFIER_MODE` supports `readonly` (default),
`accept-all`, and `reject-all`. Non-`readonly` modes are intended for testing.
`WATCHTOWER_DISPUTE_EXECUTOR_MODE` supports `auto` (default), `noop`, and
`mock`. `mock` is intended for local integration testing.
`WATCHTOWER_PRODUCER_SIGNER_MODE` currently supports `local-key` (default) and
`kms` (reserved for future signer backends; currently returns `503`).
Set `WATCHTOWER_LOG_RAW_EVENTS=true` to print raw stackflow `print` event
objects received via `/new_block` for payload inspection/debugging.
If `WATCHTOWER_PRINCIPALS` is set, the watchtower only:

1. accepts `POST /signature-states` for `forPrincipal` values in that list
2. processes closure events for pipes that include at least one listed principal

When `WATCHTOWER_PRINCIPALS` is omitted, it accepts any principal.

Health and inspection endpoints:

1. `GET /health`
2. `GET /closures`
3. `GET /pipes?limit=100&principal=ST...`
4. `GET /signature-states?limit=100`
5. `GET /dispute-attempts?limit=100`
6. `GET /events?limit=100`
7. `GET /app` (built-in browser UI)

Producer signing endpoints:

1. `POST /producer/transfer`
2. `POST /producer/signature-request`

`/producer/transfer` signs transfer states (`action = 1`).
`/producer/signature-request` signs close/deposit/withdraw states
(`action = 0|2|3`).
For `action = 2|3` (deposit/withdraw), include `amount` in the request body.
Both endpoints:

1. check local signing policy against stored state:
   - reject if nonce is not strictly higher than latest known nonce
   - reject if producer balance would decrease
   - for transfer (`action = 1`), require producer balance to strictly increase
2. verify the counterparty signature (`verify-signature-request`)
3. generate the producer signature
4. store the full signature pair via the existing signature-state pipeline

Producer signature verification uses `verify-signature-request` (read-only) to
apply action-aware on-chain balance logic, including `amount` checks for
deposit/withdraw requests.

Signature state ingestion endpoint:

1. `POST /signature-states`

Example payload:

```json
{
  "contractId": "ST....stackflow-0-6-0",
  "forPrincipal": "ST...",
  "withPrincipal": "ST...",
  "token": null,
  "myBalance": "900000",
  "theirBalance": "100000",
  "mySignature": "0x...",
  "theirSignature": "0x...",
  "nonce": "42",
  "action": "1",
  "actor": "ST...",
  "secret": null,
  "validAfter": null,
  "beneficialOnly": false
}
```

The watchtower stores one latest state per `(contract, pipe, forPrincipal)`,
replacing only when the incoming nonce is strictly greater.
Before storing, the watchtower verifies signatures by calling the Stackflow
contract read-only function `verify-signatures`. If validation fails, the
request returns `401` and nothing is stored.
If the incoming nonce is not strictly higher than the stored nonce for that
`(contract, pipe, forPrincipal)`, the request returns `409`.
If `forPrincipal` is not in `WATCHTOWER_PRINCIPALS`, the request returns `403`.

On-chain pipe tracking:

1. `POST /new_block` print events update a persistent `pipes` view
2. events such as `fund-pipe`, `deposit`, `withdraw`, `force-cancel`, and
   `force-close` upsert current pipe balances
3. terminal events (`close-pipe`, `dispute-closure`, `finalize`) reset tracked
   balances to `0` and clear pending values
4. `POST /new_burn_block` advances pending deposits into confirmed balances
   once pending `burn-height` is reached
5. `GET /pipes` merges this on-chain view with stored signature states and
   returns the authoritative state per pipe by highest nonce (ties prefer
   newer timestamps, then on-chain source)

Event observer ingestion endpoint:

1. `POST /new_block`
2. `POST /new_burn_block`

When Clarinet/stacks-node observer config uses `events_keys = ["*"]`, stacks-node
can also call additional observer endpoints. The watchtower responds `200` (no-op)
for compatibility on:

1. `POST /new_mempool_tx`
2. `POST /drop_mempool_tx`
3. `POST /new_microblocks`

For Clarinet devnet, set the observer in `settings/Devnet.toml`:

```toml
[devnet]
stacks_node_events_observers = ["host.docker.internal:8787"]
```

Open the built-in UI in your browser:

```text
http://localhost:8787/app
```

The UI lets you:

1. connect a Stacks wallet
2. load watched pipes from on-chain observer state (`GET /pipes`)
3. generate SIP-018 structured signatures for Stackflow state
4. submit signature states to `POST /signature-states`
5. call Stackflow contract methods (`fund-pipe`, `deposit`, `withdraw`,
   `force-cancel`, `force-close`, `close-pipe`, `finalize`) via wallet popup

Integration tests for the HTTP server are opt-in (they spawn a real process and
bind a local port):

```bash
npm run test:watchtower:http
```

# Reference Server Implementation

As discussed in the details, users of Stackflow should run a server to keep
track of balances and signatures for its open Pipes, and to receive messages
from its counterparts in those Pipes. A reference implementation of this server
is provided in https://github.com/obycode/stackflow-server. This server consists
of the backend for managing these details, as well as a frontend to provide a
simple interface for opening Pipes and interacting with existing Pipes.
