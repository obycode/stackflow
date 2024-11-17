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
Alternatively, the channel can be closed by calling `force-close-channel` with
the latest signed messages from both participants. In this case, either party
has 288 Bitcoin blocks (~2 days) to rebut the submitted balances by submitting a
newer set of signed messages.

Channels can be chained together to enable payments between users who do not
have a direct channel open between them. This is done by routing the payment
through intermediaries who have channels open with both the sender and receiver.
Off-chain, tools can find the most efficient route to route the payment.
Intermediary nodes can charge a fee for routing payments. In the case of chained
channels, the signed messages passed around include a requirement for a secret
to unlock the funds. This ensures that if any hop in the chain fails to send the
tokens as promised, the whole transaction can be reverted, ensuring that the
sender and receiver can ensure they payment goes through or they get their
tokens back, even with untrusted intermediaries.

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

### Channel Balance

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
   secret-hash: (optional (buff 64))
}
```

### Next Hops

The next part of the transfer message describes what the receiver must do in
order to get the channel balance confirmed. For the final hop in the chain, the
target receiver of the payment will have no next hop, since at that point, the
payment is complete. For all other hops in the chain, the receiver of the
message uses the next hop to determine how to build its transfer message,
defining which principal to send to, `receiver`, how much to send, `amount`, an
encrypted secret, `secret`, and an array of encrypted information about the hops
in the transaction chain, `next_hops`.

```js
{
   receiver: principal,
   amount: uint,
   secret: buffer,
   next_hops: buffer[8],
}
```

`secret` is encrypted iteratively, such that it must be decrypted by each hop
and passed onto the next. For example, with a path of **A** → **B** → **C** →
**D**, **A** would generate a secret, `secret`, and then send the following to
the first hop, **B**:

```js
encrypt(encrypt(encrypt(secret, pk_D), pk_C), pk_B);
```

Each layer decrypts the secret, then sends the result on to the next hop. When
the secret finally reaches the destination, **D**, **A**'s secret will be fully
decrypted.

`next_hops` is an array of 8 buffers that may hold encrypted next hop
information for one step in this transaction, or they may just contain random
data. This is done so that no node in the chain is able to learn anything about
the length of the chain, preserving privacy. Each hop in the chain attempts to
decrypt each buffer until it finds the one encrypted with its public key.

```js
{
   receiver: principal,
   amount: uint,
}
```

For the final hop in the chain, **D** in our example, the `receiver` is set to
**D** and the amount is set to `0`.
