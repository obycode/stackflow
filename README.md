Stackflow is a payment channel network built on Stacks that enables off-chain,
non-custodial, high-speed payments between users and is designed to be simple,
secure, and efficient. It supports payments in STX or approved SIP-010 fungible
tokens.

> [!NOTE]
> Official contract is published by `stackflow.btc` on mainnet at
> `SP126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT6AD08RV.stackflow-0-3-0` and on testnet at
> `ST126XFZQ3ZHYM6Q6KAQZMMJSDY91A8BTT59ZTE2J.stackflow-0-3-0`.

A Stacks address can open a channel with any other Stacks address with a
contract call to the Stackflow contract. This call sends tokens to the contract
for escrow. The tokens are locked in the contract and can only be withdrawn by
the channel participants. The channel participants can then send payments to
each other off-chain by signing
[SIP-018 structured data](https://github.com/stacksgov/sips/blob/main/sips/sip-018/sip-018-signed-structured-data.md)
indicating the agreed upon balances of each participant. These signed messages
can be exchanged off-chain and only need to be submitted on-chain when closing
the channel, depositing additional funds to, or withdrawing funds from the
channel. The messages include a nonce to track their ordering.

A channel can be closed cooperatively at any time, by both parties agreeing on
the final balances and signing off on the closure. If either party becomes
uncooperative or unresponsive, the channel can also be forecefully closed by the
other party. One party can make a contract call to initiate a waiting period to
cancel the channel, and refund the latest balances recorded in the contract, or
they can submit signatures verifying an agreed upon balance. In either case, the
other party has 144 Bitcoin blocks (~1 day) to rebut the submitted balances by
submitting a newer set of signed messages to the contract. If the closure is
successfully disputed with valid signatures, those balances are immediately paid
out and the channel is closed. If the deadline is reached with no dispute, then
one final contract call triggers the contract to send the funds back to the
addresses.

Channels can be chained together to enable payments between users who do not
have a direct channel open between them. This is done by routing the payment
through intermediaries who have channels open with both the sender and receiver.
Off-chain, tools can find the most efficient path to route the payment.
Intermediary nodes can charge a fee for routing payments. In the case of chained
channels, the signed messages passed around include a requirement for a secret
to unlock the funds. This ensures that if any hop in the chain fails to send the
tokens as promised, the whole transaction can be reverted, allowing the sender
and receiver to be sure that the payment goes through completely or they get
their tokens back, even with untrusted intermediaries.

Example:

1. Alice opens a channel with Bob.
2. Bob opens a channel with Charlie.
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

To send tokens between two parties with an active channel open in the contract,
they simply send signatures back and forth off-chain. The signatures are signing
over structured data with the details of the channel:

```clarity
{
   ;; The token for which the channel is open
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
   ;; An optional sha256 hash of a secret, used for multi-hop transfers
   hashed-secret: (optional (buff 32))
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
first, a path from **A** to **D** is identified using existing open channels
with sufficient balances, for example using Dijkstra's algorithm. If a path is
not possible, then a new channel must be opened. Once a path is defined, **A**
builds the transfer message as described above, with the addition of a secret.

The next part of the transfer message describes what the receiver must do in
order to get the channel balance confirmed. For the final hop in the chain, the
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

## Closing a channel

There are two ways to close a channel, cooperatively or forcefully. In the
normal scenario, both parties agree to close the channel and authorize the
closure by signing a message agreeing upon the final balances. One party calls
`close-channel`, passing in these balances and signatures, and then the contract
pays out both parties and the channel is closed.

In the unfortunate scenario where one party becomes uncooperative or
unresponsive, the other party needs a way to retrieve their funds from the
channel unilaterally. This user has two options:

1. `force-cancel` allows the user to close the channel and refund the initial
   balances to both parties. This option requires no signatures, but it does
   require a waiting period, allowing the other party to dispute the closure by
   submitting signatures validating a transfer on this channel.
2. `force-close` allows the user to close the channel and return the balances
   recorded in the latest transfer on this channel. Arguments to this function
   include signatures from the latest transfer, along with the agreed upon
   balances at that transfer. This function also requires a waiting period,
   allowing the other party to dispute the closure by submitting a later pair of
   signatures, indicating a more recent balance agreement (one with a higher
   nonce).

During the waiting period for both of these closures, the other party may call
`dispute-closure`, passing in balances and signatures from the latest transfer.
If the signatures are confirmed, and the nonce is higher in the case of a
`force-close`, then the channel is immediately closed, transferring with the
balances specified to both parties.

If the closure is not disputed by the time the waiting period is over, the user
may call `finalize` to complete the closure and transfer the appropriate
balances to both parties.

# Reference Server Implementation

As discussed in the details, users of Stackflow should run a server to keep
track of balances and signatures for its open channels, and to receive messages
from its counterparts in those channels. A reference implementation of this
server is provided in https://github.com/obycode/stackflow-server. This server
consists of the backend for managing these details, as well as a frontend to
provide a simple interface for opening channels and interacting with existing
channels.
