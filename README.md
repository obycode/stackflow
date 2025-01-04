Stackflow is a payment channel network built on Stacks that enables off-chain,
non-custodial, high-speed payments between users and is designed to be simple,
secure, and efficient. It supports payments in STX or approved SIP-010 fungible
tokens.

A Stacks address can open a channel with any other Stacks address by calling
`fund-channel`. This call sends tokens to the contract for escrow. The tokens
are locked in the contract and can only be withdrawn by the channel
participants. The channel participants can then send payments to each other
off-chain by signing SIP-018 structured data indicating the agreed upon balances
of each participant. These signed messages can be exchanged off-chain and only
need to be submitted on-chain when closing the channel. The messages include a
nonce to track their ordering.

The channel can be closed at any time by either participant by calling
`close-channel`, and passing in signed messages from each participant in which
they have agreed upon the desire to close the channel and on the final balances.
Alternatively, the channel can be closed by calling `force-close` with the
latest signed messages from both participants. In this case, either party has
144 Bitcoin blocks (~1 day) to rebut the submitted balances by submitting a
newer set of signed messages. If the closure is successfully disputed with valid
signatures and a higher nonce, those balances are immediately paid out and the
channel is closed.

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
   to Charlie and is willing to pay Bob 0.1 STX for routing the payment. Bob's
   proof of payment is dependent on Bob presenting a secret value along with
   this signed message.
5. Bob sends a signed message to Charlie indicating that he wants to send him 10
   STX. Charlie's proof of payment is dependent on presenting a secret value
   along with this signed message.

In the above scenario, Bob cannot obtain the secret unless he sends the payment
to Charlie, so he is unable to keep the payment from Alice without sending the
payment to Charlie. Details of how this works are discussed below.

## Details

When principal **A** wants to send tokens to principal **D** using StackFlow,
first, a path from **A** to **D** is identified using existing open channels,
for example using Dijkstra's algorithm. If a path is not possible, then a new
channel must be opened. Once a path is defined, **A** builds the transfer
message.

### Transfer Message

In the transfer message, first we have a channel balance component in which
**A** is confirming a new set of balances for the channel. This structure may
contain an optional secret hash which serves as a condition for the balance to
be confirmed.

```clarity
{
   token: (optional principal),
   principal-1: principal,
   principal-2: principal,
   balance-1: uint,
   balance-2: uint,
   nonce: uint,
   action: uint,
   actor: (optional principal),
   hashed-secret: (optional (buff 32))
}
```

Along with this tuple, the sender sends its signature, signing over this value.
The receiver should first validate the signature before taking any other action.

### Next Hops

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
};
```

The initial sender constructs an array of 8 of these objects, encrypting each
with the public key of the intended target. If less than 8 hops are needed, then
random data is filled into the remaining slots. The sender then sends this
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

In the unfortunate scenario where one party becomes unresponsive, the other
party needs a way to retrieve their funds from the channel unilaterally. This
user has two options:

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

If the closure is not disputed by the time the waiting period is over, the the
user may call `finalize` to complete the closure and transfer the appropriate
balances to both parties.
